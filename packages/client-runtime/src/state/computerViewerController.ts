import type {
  ComputerAction,
  ComputerError,
  ComputerEvent,
  ComputerSession,
  ComputerState,
} from "@t3tools/contracts";

import {
  initialComputerViewerState,
  reduceComputerViewer,
  type ComputerViewerEvent,
  type ComputerViewerState,
} from "./computerViewer.ts";

export type ComputerViewerFailure = ComputerError["code"] | "transport";

export type ComputerViewerOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly code: ComputerViewerFailure };

/** The computer RPCs for one thread, adapted by each client from its atom commands. */
export interface ComputerViewerPort {
  readonly getState: () => Promise<ComputerViewerOutcome<ComputerState>>;
  readonly open: () => Promise<ComputerViewerOutcome<ComputerState>>;
  readonly acquire: () => Promise<ComputerViewerOutcome<ComputerSession>>;
  readonly input: (input: {
    readonly sessionId: string;
    readonly sequence: number;
    readonly action: ComputerAction;
  }) => Promise<ComputerViewerOutcome<void>>;
  readonly release: (sessionId: string) => Promise<ComputerViewerOutcome<ComputerState>>;
  readonly close: () => Promise<ComputerViewerOutcome<ComputerState>>;
  readonly stop: () => Promise<ComputerViewerOutcome<ComputerState>>;
}

/** Queued input is bounded; a client that outruns the computer loses the oldest moves first. */
export const COMPUTER_VIEWER_INPUT_QUEUE_LIMIT = 32;
const SCROLL_LIMIT = 2000;

export interface ComputerViewerController {
  readonly getState: () => ComputerViewerState;
  readonly subscribe: (listener: (state: ComputerViewerState) => void) => () => void;
  /** Applies connection, stream, and clock facts from the client's own sources. */
  readonly dispatch: (event: ComputerViewerEvent) => void;
  readonly receive: (event: ComputerEvent) => void;
  readonly show: () => Promise<void>;
  /** Closes the viewer, which also returns any held control to the bot. Safe to call repeatedly. */
  readonly hide: () => Promise<void>;
  readonly takeControl: () => Promise<void>;
  readonly returnControl: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly resume: () => Promise<void>;
  readonly sendInput: (action: ComputerAction) => void;
}

/**
 * Owns one viewer's lifecycle. Commands are serialized through the reducer so
 * the viewer never believes it holds control the server has not granted, and
 * input is sent strictly in order with the next lease sequence.
 */
export function createComputerViewerController(options: {
  readonly port: ComputerViewerPort;
  /** Called after `open` succeeds so the client can resubscribe to a stream that ended on stop. */
  readonly onReopened?: () => void;
}): ComputerViewerController {
  const { port } = options;
  let state = initialComputerViewerState;
  const listeners = new Set<(state: ComputerViewerState) => void>();
  let queue: ComputerAction[] = [];
  let draining = false;

  const dispatch = (event: ComputerViewerEvent) => {
    const next = reduceComputerViewer(state, event);
    if (next === state) return;
    const lostLease = state.lease !== null && next.lease?.sessionId !== state.lease.sessionId;
    state = next;
    if (lostLease) queue = [];
    for (const listener of listeners) listener(state);
  };

  const refreshState = async () => {
    const outcome = await port.getState();
    if (outcome.ok && state.visible) dispatch({ type: "server-state", state: outcome.value });
  };

  // A failed command usually means the computer changed under us; re-read it.
  const settle = <A>(outcome: ComputerViewerOutcome<A>, onSuccess: (value: A) => void) => {
    if (outcome.ok) onSuccess(outcome.value);
    else {
      dispatch({ type: "failed", code: outcome.code });
      if (outcome.code !== "transport") void refreshState();
    }
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const lease = state.lease;
        if (lease === null || !state.visible) {
          queue = [];
          return;
        }
        const action = queue.shift()!;
        const outcome = await port.input({
          sessionId: lease.sessionId,
          sequence: lease.sequence + 1,
          action,
        });
        if (state.lease?.sessionId !== lease.sessionId) continue;
        if (!outcome.ok && outcome.code !== "transport") {
          dispatch({ type: "failed", code: outcome.code });
          // The server may still hold the lease this client just gave up, which
          // would keep the bot waiting. Hand it back before re-reading state.
          await port.release(lease.sessionId);
          void refreshState();
          continue;
        }
        settle(outcome, () => dispatch({ type: "input-sent" }));
      }
    } finally {
      draining = false;
    }
  };

  const enqueue = (action: ComputerAction) => {
    const last = queue.at(-1);
    if (
      action._tag === "scroll" &&
      last?._tag === "scroll" &&
      last.direction === action.direction
    ) {
      queue[queue.length - 1] = {
        ...last,
        amount: Math.min(SCROLL_LIMIT, last.amount + action.amount),
      };
      return;
    }
    if (queue.length >= COMPUTER_VIEWER_INPUT_QUEUE_LIMIT) {
      const moveIndex = queue.findIndex((queued) => queued._tag === "move");
      if (moveIndex === -1) return;
      queue.splice(moveIndex, 1);
    }
    queue.push(action);
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch,
    receive: (event) => {
      if (!state.visible) return;
      if (event._tag === "state") dispatch({ type: "server-state", state: event.state });
      else if (event._tag === "frame") dispatch({ type: "frame", frame: event.frame });
    },
    show: async () => {
      if (state.visible) return;
      dispatch({ type: "visibility", visible: true });
      await refreshState();
    },
    hide: async () => {
      if (!state.visible) return;
      queue = [];
      dispatch({ type: "visibility", visible: false });
      // Closing releases any lease this connection holds, so the bot resumes.
      await port.close();
    },
    takeControl: async () => {
      dispatch({ type: "pending", pending: "acquire" });
      const outcome = await port.acquire();
      if (!state.visible) {
        // The viewer closed while acquiring; hand control straight back.
        if (outcome.ok) await port.release(outcome.value.sessionId);
        return;
      }
      settle(outcome, (session) => dispatch({ type: "acquired", session }));
    },
    returnControl: async () => {
      const lease = state.lease;
      if (lease === null) return;
      queue = [];
      dispatch({ type: "pending", pending: "release" });
      settle(await port.release(lease.sessionId), (next) =>
        dispatch({ type: "released", state: next }),
      );
    },
    stop: async () => {
      queue = [];
      dispatch({ type: "pending", pending: "stop" });
      settle(await port.stop(), (next) => dispatch({ type: "stopped", state: next }));
    },
    resume: async () => {
      dispatch({ type: "pending", pending: "open" });
      settle(await port.open(), (next) => {
        dispatch({ type: "opened", state: next });
        options.onReopened?.();
      });
    },
    sendInput: (action) => {
      if (state.lease === null || state.pending !== null) return;
      enqueue(action);
      void drain();
    },
  };
}
