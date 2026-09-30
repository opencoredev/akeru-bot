import type {
  BotSandbox,
  ComputerAction,
  ComputerError,
  ComputerFrame,
  ComputerSession,
  ComputerState,
} from "@akeru/contracts";

/**
 * Client lifecycle for watching and controlling a bot's workspace computer.
 *
 * The server is authoritative for who owns input. This reducer only records
 * what this client knows: the latest server state, the lease this connection
 * holds, and the latest frame. `deriveComputerViewer` turns those facts into
 * exactly one owner so no surface can render two at once.
 */

/** Why this client lost or never got its lease. Shown once, cleared by the next action. */
export type ComputerViewerNotice =
  | "expired"
  | "revoked"
  | "stopped"
  | "ended"
  | "disconnected"
  | "busy"
  | "failed";

export interface ComputerViewerLease {
  readonly sessionId: string;
  readonly expiresAt: number;
  /** Last sequence sent. The next input uses `sequence + 1`. */
  readonly sequence: number;
  /**
   * Whether the event stream has reported `human` since this lease was granted.
   * Until it has, a `ready` state may predate the acquire and is not proof of loss.
   */
  readonly confirmed: boolean;
}

export type ComputerViewerPending = "open" | "acquire" | "release" | "stop" | null;

export interface ComputerViewerState {
  /** The viewer is on screen and should hold a subscription. */
  readonly visible: boolean;
  readonly connected: boolean;
  readonly server: ComputerState | null;
  /** Only the latest frame is kept; older frames are dropped, never queued. */
  readonly frame: ComputerFrame | null;
  readonly lease: ComputerViewerLease | null;
  readonly pending: ComputerViewerPending;
  readonly notice: ComputerViewerNotice | null;
}

export type ComputerViewerEvent =
  | { readonly type: "visibility"; readonly visible: boolean }
  | { readonly type: "connection"; readonly connected: boolean }
  | { readonly type: "server-state"; readonly state: ComputerState }
  | { readonly type: "frame"; readonly frame: ComputerFrame }
  | { readonly type: "pending"; readonly pending: Exclude<ComputerViewerPending, null> }
  | { readonly type: "opened"; readonly state: ComputerState }
  | { readonly type: "acquired"; readonly session: ComputerSession }
  | { readonly type: "released"; readonly state: ComputerState }
  | { readonly type: "stopped"; readonly state: ComputerState }
  | { readonly type: "input-sent" }
  | { readonly type: "failed"; readonly code: ComputerError["code"] | "transport" }
  | { readonly type: "tick"; readonly now: number };

export const initialComputerViewerState: ComputerViewerState = {
  visible: false,
  connected: true,
  server: null,
  frame: null,
  lease: null,
  pending: null,
  notice: null,
};

function dropLease(
  state: ComputerViewerState,
  notice: ComputerViewerNotice | null,
): ComputerViewerState {
  if (state.lease === null && state.pending !== "acquire") return state;
  return { ...state, lease: null, pending: null, notice: notice ?? state.notice };
}

function lossNotice(status: ComputerState["status"]): ComputerViewerNotice {
  if (status === "stopped") return "stopped";
  if (status === "unavailable") return "ended";
  return "revoked";
}

function failureNotice(code: ComputerError["code"] | "transport"): ComputerViewerNotice {
  switch (code) {
    case "busy":
      return "busy";
    case "closed":
      return "stopped";
    case "revoked":
    case "sequence":
      return "revoked";
    case "transport":
      return "disconnected";
    default:
      return "failed";
  }
}

function applyServerState(state: ComputerViewerState, server: ComputerState): ComputerViewerState {
  const next: ComputerViewerState = {
    ...state,
    server,
    // A stopped or unavailable computer has no current picture.
    frame: server.status === "ready" || server.status === "human" ? state.frame : null,
  };
  const lease = next.lease;
  if (lease === null) return next;
  if (server.status === "human") {
    return lease.confirmed ? next : { ...next, lease: { ...lease, confirmed: true } };
  }
  // A `ready` report that predates the acquire is not proof the lease is gone.
  if (server.status === "ready" && !lease.confirmed) return next;
  return dropLease(next, lossNotice(server.status));
}

export function reduceComputerViewer(
  state: ComputerViewerState,
  event: ComputerViewerEvent,
): ComputerViewerState {
  switch (event.type) {
    case "visibility": {
      if (event.visible === state.visible) return state;
      if (event.visible) return { ...state, visible: true };
      // Hidden viewers drop their stream and any held control. The caller
      // returns control to the bot; the frame is not kept for a later show.
      return { ...initialComputerViewerState, connected: state.connected };
    }
    case "connection": {
      if (event.connected === state.connected) return state;
      if (event.connected) return { ...state, connected: true };
      // The server stops the computer when an owner disconnects, so a lease
      // never survives a reconnect. Server state is unknown until resubscribed.
      const hadLease = state.lease !== null || state.pending === "acquire";
      return {
        ...state,
        connected: false,
        server: null,
        frame: null,
        lease: null,
        pending: null,
        notice: hadLease ? "disconnected" : state.notice,
      };
    }
    case "server-state":
      return applyServerState(state, event.state);
    case "frame":
      if (state.server?.status !== "ready" && state.server?.status !== "human") return state;
      return { ...state, frame: event.frame };
    case "pending":
      return { ...state, pending: event.pending, notice: null };
    case "opened":
      return applyServerState({ ...state, pending: null }, event.state);
    case "acquired":
      return applyServerState(
        {
          ...state,
          pending: null,
          notice: null,
          lease: {
            sessionId: event.session.sessionId,
            expiresAt: event.session.expiresAt,
            sequence: 0,
            confirmed: false,
          },
        },
        event.session.state,
      );
    case "released":
      return applyServerState({ ...state, pending: null, lease: null }, event.state);
    case "stopped":
      return applyServerState({ ...state, pending: null, lease: null }, event.state);
    case "input-sent":
      if (state.lease === null) return state;
      return { ...state, lease: { ...state.lease, sequence: state.lease.sequence + 1 } };
    case "failed": {
      const notice = failureNotice(event.code);
      // Uncertain input is never replayed: any failure while holding control
      // gives the lease up rather than guessing the next sequence.
      if (state.lease !== null || state.pending === "acquire") return dropLease(state, notice);
      return { ...state, pending: null, notice };
    }
    case "tick": {
      if (state.lease === null || event.now < state.lease.expiresAt) return state;
      // The server stops the whole computer when a lease runs out, so the
      // last reported "human" status must not read as someone else's control.
      const expired = dropLease(state, "expired");
      return expired.server === null
        ? expired
        : { ...expired, server: { ...expired.server, status: "stopped" }, frame: null };
    }
  }
}

export type ComputerViewerOwner = "bot" | "you" | "someone-else" | "nobody";

export type ComputerViewerPhase =
  | "hidden"
  | "connecting"
  | "reconnecting"
  | "unsupported"
  | "stopped"
  | "live";

export interface ComputerViewerView {
  readonly phase: ComputerViewerPhase;
  /** Exactly one owner at any moment. */
  readonly owner: ComputerViewerOwner;
  readonly canTakeControl: boolean;
  readonly canReturnControl: boolean;
  readonly canStop: boolean;
  readonly canResume: boolean;
  readonly canSendInput: boolean;
  readonly controlUnavailableReason: string | null;
}

export function deriveComputerViewer(state: ComputerViewerState): ComputerViewerView {
  const server = state.server;
  const idle = state.pending === null;
  const base = {
    canTakeControl: false,
    canReturnControl: false,
    canStop: false,
    canResume: false,
    canSendInput: false,
    controlUnavailableReason: null,
  };
  if (!state.visible) return { ...base, phase: "hidden", owner: "nobody" };
  if (!state.connected) return { ...base, phase: "reconnecting", owner: "nobody" };
  if (server === null) return { ...base, phase: "connecting", owner: "nobody" };
  if (server.status === "unavailable" || server.capability === "none") {
    return { ...base, phase: "unsupported", owner: "nobody" };
  }
  if (server.status === "stopped" || server.status === "closed") {
    return { ...base, phase: "stopped", owner: "nobody", canResume: idle };
  }
  const owner: ComputerViewerOwner =
    state.lease !== null ? "you" : server.status === "human" ? "someone-else" : "bot";
  return {
    ...base,
    phase: "live",
    owner,
    canTakeControl: idle && owner === "bot" && server.controlAvailable,
    canReturnControl: idle && owner === "you",
    canStop: idle,
    canSendInput: owner === "you" && state.pending === null,
    controlUnavailableReason: server.controlAvailable ? null : server.reason,
  };
}

/**
 * Which workspaces can expose a graphical computer, mirroring the server core.
 * Keep in sync with docs/internals/computer-control.md.
 */
export const COMPUTER_SANDBOX_CAPABILITY: Readonly<
  Record<BotSandbox, { readonly graphical: boolean }>
> = {
  local: { graphical: false },
  e2b: { graphical: false },
  daytona: { graphical: true },
  vercel: { graphical: false },
  upstash: { graphical: false },
  railway: { graphical: false },
  tenki: { graphical: false },
};

/** Provider drivers that route browser input through the shared computer gate. */
export const COMPUTER_CONTROL_PROVIDERS: ReadonlySet<string> = new Set(["codex", "kimi"]);

export type ComputerCapabilityExplanation =
  | "local"
  | "sandbox"
  | "provider"
  | "not-running"
  | "available";

/**
 * Explains why a bot has, or lacks, a viewable computer. The server state wins
 * when it reports a desktop; otherwise the bot's sandbox and provider explain
 * which part of the matrix is missing.
 */
export function explainComputerCapability(input: {
  readonly sandbox: BotSandbox | null;
  readonly provider: string | null;
  readonly state: ComputerState | null;
}): ComputerCapabilityExplanation {
  if (input.state !== null && input.state.capability !== "none") return "available";
  const sandbox = input.sandbox ?? "local";
  if (sandbox === "local") return "local";
  if (!COMPUTER_SANDBOX_CAPABILITY[sandbox].graphical) return "sandbox";
  if (input.provider === null || !COMPUTER_CONTROL_PROVIDERS.has(input.provider)) {
    return "provider";
  }
  return "not-running";
}

/** Maps a pointer position on the rendered frame to computer coordinates. */
export function computerFramePoint(input: {
  readonly frame: Pick<ComputerFrame, "width" | "height">;
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly clientX: number;
  readonly clientY: number;
}): { readonly x: number; readonly y: number } | null {
  const { frame, rect } = input;
  if (rect.width <= 0 || rect.height <= 0) return null;
  const relativeX = (input.clientX - rect.left) / rect.width;
  const relativeY = (input.clientY - rect.top) / rect.height;
  if (relativeX < 0 || relativeX > 1 || relativeY < 0 || relativeY > 1) return null;
  return {
    x: Math.min(frame.width - 1, Math.floor(relativeX * frame.width)),
    y: Math.min(frame.height - 1, Math.floor(relativeY * frame.height)),
  };
}

const COMPUTER_KEY_NAMES: Readonly<Record<string, string>> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  " ": "space",
};

/**
 * Translates a keyboard event into a computer action. Plain printable keys
 * type text; named keys and modifier chords become xdotool-style hotkeys.
 * Returns null for bare modifiers and keys the computer cannot receive.
 */
export function computerKeyAction(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): ComputerAction | null {
  const chord = event.ctrlKey || event.altKey || event.metaKey;
  if (!chord && event.key.length === 1) return { _tag: "type", text: event.key };
  const named =
    COMPUTER_KEY_NAMES[event.key] ?? (event.key.length === 1 ? event.key.toLowerCase() : null);
  if (named === null) return null;
  const modifiers = [
    event.ctrlKey ? "ctrl" : null,
    event.altKey ? "alt" : null,
    event.shiftKey && (chord || event.key.length > 1) ? "shift" : null,
    event.metaKey ? "super" : null,
  ].filter((modifier) => modifier !== null);
  return { _tag: "key", key: [...modifiers, named].join("+") };
}
