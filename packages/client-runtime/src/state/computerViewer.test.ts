import { ThreadId, type ComputerFrame, type ComputerState } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computerFramePoint,
  computerKeyAction,
  deriveComputerViewer,
  explainComputerCapability,
  initialComputerViewerState,
  reduceComputerViewer,
  type ComputerViewerEvent,
  type ComputerViewerState,
} from "./computerViewer.ts";

const threadId = ThreadId.make("thread-computer");

function serverState(overrides: Partial<ComputerState> = {}): ComputerState {
  return {
    threadId,
    status: "ready",
    capability: "desktop",
    controlAvailable: true,
    reason: null,
    workspaceId: "workspace-1",
    ...overrides,
  };
}

const frame: ComputerFrame = { mimeType: "image/png", data: "AAAA", width: 1280, height: 800 };

function run(...events: ComputerViewerEvent[]): ComputerViewerState {
  return events.reduce(reduceComputerViewer, initialComputerViewerState);
}

const visibleReady: ComputerViewerEvent[] = [
  { type: "visibility", visible: true },
  { type: "server-state", state: serverState() },
];

const acquired: ComputerViewerEvent = {
  type: "acquired",
  session: { sessionId: "lease-1", expiresAt: 60_000, state: serverState({ status: "human" }) },
};

describe("computer viewer state", () => {
  it("is hidden and owner-less until shown", () => {
    expect(deriveComputerViewer(initialComputerViewerState)).toMatchObject({
      phase: "hidden",
      owner: "nobody",
    });
    expect(deriveComputerViewer(run({ type: "visibility", visible: true }))).toMatchObject({
      phase: "connecting",
    });
  });

  it("takes control, sends ordered input, and returns control to the bot", () => {
    let state = run(...visibleReady);
    expect(deriveComputerViewer(state)).toMatchObject({
      phase: "live",
      owner: "bot",
      canTakeControl: true,
      canReturnControl: false,
      canSendInput: false,
    });

    state = reduceComputerViewer(state, { type: "pending", pending: "acquire" });
    expect(deriveComputerViewer(state).canTakeControl).toBe(false);

    state = reduceComputerViewer(state, acquired);
    expect(state.lease).toMatchObject({ sessionId: "lease-1", sequence: 0, confirmed: true });
    expect(deriveComputerViewer(state)).toMatchObject({
      owner: "you",
      canReturnControl: true,
      canSendInput: true,
    });

    state = reduceComputerViewer(state, { type: "input-sent" });
    state = reduceComputerViewer(state, { type: "input-sent" });
    expect(state.lease?.sequence).toBe(2);

    state = reduceComputerViewer(state, { type: "pending", pending: "release" });
    expect(deriveComputerViewer(state).canSendInput).toBe(false);
    state = reduceComputerViewer(state, { type: "released", state: serverState() });
    expect(state.lease).toBeNull();
    expect(deriveComputerViewer(state).owner).toBe("bot");
  });

  it("stops the computer and offers resume", () => {
    let state = run(...visibleReady, acquired, { type: "pending", pending: "stop" });
    state = reduceComputerViewer(state, {
      type: "stopped",
      state: serverState({ status: "stopped" }),
    });
    expect(state.lease).toBeNull();
    expect(state.frame).toBeNull();
    expect(deriveComputerViewer(state)).toMatchObject({
      phase: "stopped",
      owner: "nobody",
      canResume: true,
      canTakeControl: false,
    });
    state = reduceComputerViewer(state, { type: "pending", pending: "open" });
    state = reduceComputerViewer(state, { type: "opened", state: serverState() });
    expect(deriveComputerViewer(state)).toMatchObject({ phase: "live", owner: "bot" });
  });

  it("shows another client's control without claiming it", () => {
    const state = run(...visibleReady, {
      type: "server-state",
      state: serverState({ status: "human" }),
    });
    expect(deriveComputerViewer(state)).toMatchObject({
      owner: "someone-else",
      canTakeControl: false,
      canReturnControl: false,
      canSendInput: false,
    });
  });

  it("ignores a ready report that predates the lease", () => {
    let state = run(...visibleReady, {
      type: "acquired",
      session: { sessionId: "lease-1", expiresAt: 60_000, state: serverState() },
    });
    state = reduceComputerViewer(state, { type: "server-state", state: serverState() });
    expect(state.lease?.sessionId).toBe("lease-1");
    state = reduceComputerViewer(state, {
      type: "server-state",
      state: serverState({ status: "human" }),
    });
    expect(state.lease?.confirmed).toBe(true);
    state = reduceComputerViewer(state, { type: "server-state", state: serverState() });
    expect(state.lease).toBeNull();
    expect(state.notice).toBe("revoked");
    expect(deriveComputerViewer(state).owner).toBe("bot");
  });

  it("expires a stale lease on the next tick", () => {
    let state = run(...visibleReady, acquired, { type: "tick", now: 59_999 });
    expect(state.lease).not.toBeNull();
    state = reduceComputerViewer(state, { type: "tick", now: 60_000 });
    expect(state.lease).toBeNull();
    expect(state.notice).toBe("expired");
    expect(deriveComputerViewer(state)).toMatchObject({
      phase: "stopped",
      owner: "nobody",
      canSendInput: false,
      canResume: true,
    });
  });

  it("gives up the lease on any rejected input instead of replaying it", () => {
    for (const code of ["revoked", "sequence", "closed", "adapter"] as const) {
      const state = run(...visibleReady, acquired, { type: "failed", code });
      expect(state.lease).toBeNull();
      expect(deriveComputerViewer(state).owner).not.toBe("you");
    }
  });

  it("reports a busy computer when another client wins the race", () => {
    const state = run(
      ...visibleReady,
      { type: "pending", pending: "acquire" },
      { type: "failed", code: "busy" },
    );
    expect(state.notice).toBe("busy");
    expect(state.pending).toBeNull();
  });

  it("drops control and frames on disconnect and waits for fresh state on reconnect", () => {
    let state = run(...visibleReady, acquired, { type: "frame", frame });
    state = reduceComputerViewer(state, { type: "connection", connected: false });
    expect(state).toMatchObject({ lease: null, frame: null, server: null, notice: "disconnected" });
    expect(deriveComputerViewer(state)).toMatchObject({ phase: "reconnecting", owner: "nobody" });
    state = reduceComputerViewer(state, { type: "connection", connected: true });
    expect(deriveComputerViewer(state).phase).toBe("connecting");
    state = reduceComputerViewer(state, { type: "server-state", state: serverState() });
    expect(deriveComputerViewer(state).owner).toBe("bot");
  });

  it("ends control when the bot is cancelled or the workspace sleeps", () => {
    const cancelled = run(...visibleReady, acquired, {
      type: "server-state",
      state: serverState({ status: "unavailable", capability: "none" }),
    });
    expect(cancelled.notice).toBe("ended");
    expect(deriveComputerViewer(cancelled)).toMatchObject({
      phase: "unsupported",
      owner: "nobody",
    });

    const asleep = run(...visibleReady, acquired, {
      type: "server-state",
      state: serverState({ status: "stopped" }),
    });
    expect(asleep.notice).toBe("stopped");
    expect(deriveComputerViewer(asleep)).toMatchObject({ phase: "stopped", owner: "nobody" });
  });

  it("keeps only the latest frame and ignores frames without a live computer", () => {
    const second = { ...frame, data: "BBBB" };
    let state = run(...visibleReady, { type: "frame", frame }, { type: "frame", frame: second });
    expect(state.frame).toBe(second);
    state = reduceComputerViewer(state, {
      type: "server-state",
      state: serverState({ status: "stopped" }),
    });
    state = reduceComputerViewer(state, { type: "frame", frame });
    expect(state.frame).toBeNull();
  });

  it("clears everything when hidden", () => {
    const state = run(
      ...visibleReady,
      acquired,
      { type: "frame", frame },
      {
        type: "visibility",
        visible: false,
      },
    );
    expect(state).toEqual(initialComputerViewerState);
  });

  it("explains control that the server withholds", () => {
    const state = run(
      { type: "visibility", visible: true },
      {
        type: "server-state",
        state: serverState({ controlAvailable: false, reason: "Raw MCP browser attached." }),
      },
    );
    expect(deriveComputerViewer(state)).toMatchObject({
      owner: "bot",
      canTakeControl: false,
      controlUnavailableReason: "Raw MCP browser attached.",
    });
  });
});

describe("computer capability", () => {
  it("explains each cell of the matrix", () => {
    const none = serverState({ status: "unavailable", capability: "none" });
    expect(explainComputerCapability({ sandbox: null, provider: "codex", state: none })).toBe(
      "local",
    );
    for (const sandbox of ["e2b", "vercel", "upstash"] as const) {
      expect(explainComputerCapability({ sandbox, provider: "codex", state: none })).toBe(
        "sandbox",
      );
    }
    for (const provider of ["claudeAgent", "grok", "opencode", null]) {
      expect(explainComputerCapability({ sandbox: "daytona", provider, state: none })).toBe(
        "provider",
      );
    }
    for (const provider of ["codex", "kimi"]) {
      expect(explainComputerCapability({ sandbox: "daytona", provider, state: none })).toBe(
        "not-running",
      );
    }
    expect(
      explainComputerCapability({ sandbox: "daytona", provider: "kimi", state: serverState() }),
    ).toBe("available");
  });

  it("maps pointer positions into frame coordinates", () => {
    const rect = { left: 10, top: 20, width: 640, height: 400 };
    expect(computerFramePoint({ frame, rect, clientX: 10, clientY: 20 })).toEqual({ x: 0, y: 0 });
    expect(computerFramePoint({ frame, rect, clientX: 330, clientY: 220 })).toEqual({
      x: 640,
      y: 400,
    });
    expect(computerFramePoint({ frame, rect, clientX: 650, clientY: 420 })).toEqual({
      x: 1279,
      y: 799,
    });
    expect(computerFramePoint({ frame, rect, clientX: 5, clientY: 20 })).toBeNull();
  });
});

describe("computer keys", () => {
  const plain = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
  it("types printable keys and maps named keys and chords", () => {
    expect(computerKeyAction({ ...plain, key: "a" })).toEqual({ _tag: "type", text: "a" });
    expect(computerKeyAction({ ...plain, key: "A", shiftKey: true })).toEqual({
      _tag: "type",
      text: "A",
    });
    expect(computerKeyAction({ ...plain, key: "Enter" })).toEqual({ _tag: "key", key: "Return" });
    expect(computerKeyAction({ ...plain, key: "Tab", shiftKey: true })).toEqual({
      _tag: "key",
      key: "shift+Tab",
    });
    expect(computerKeyAction({ ...plain, key: "c", ctrlKey: true })).toEqual({
      _tag: "key",
      key: "ctrl+c",
    });
    expect(computerKeyAction({ ...plain, key: "Shift", shiftKey: true })).toBeNull();
    expect(computerKeyAction({ ...plain, key: "F13" })).toBeNull();
  });
});
