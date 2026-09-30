import {
  ThreadId,
  type ComputerAction,
  type ComputerSession,
  type ComputerState,
} from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveComputerViewer } from "./computerViewer.ts";
import {
  COMPUTER_VIEWER_INPUT_QUEUE_LIMIT,
  createComputerViewerController,
  type ComputerViewerOutcome,
  type ComputerViewerPort,
} from "./computerViewerController.ts";

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

interface Deferred<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
}

function deferred<A>(): Deferred<A> {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const ok = <A>(value: A): ComputerViewerOutcome<A> => ({ ok: true, value });

function fakePort() {
  const calls: string[] = [];
  const inputs: Array<{ sequence: number; action: ComputerAction }> = [];
  let pendingInput: Deferred<ComputerViewerOutcome<void>> | null = null;
  let server = serverState();
  const port: ComputerViewerPort = {
    getState: async () => {
      calls.push("getState");
      return ok(server);
    },
    open: async () => {
      calls.push("open");
      server = serverState();
      return ok(server);
    },
    acquire: async () => {
      calls.push("acquire");
      server = serverState({ status: "human" });
      const session: ComputerSession = { sessionId: "lease-1", expiresAt: 60_000, state: server };
      return ok(session);
    },
    input: (input) => {
      inputs.push({ sequence: input.sequence, action: input.action });
      pendingInput = deferred();
      return pendingInput.promise;
    },
    release: async () => {
      calls.push("release");
      if (server.status === "stopped") return { ok: false, code: "closed" };
      server = serverState();
      return ok(server);
    },
    close: async () => {
      calls.push("close");
      server = serverState();
      return ok(server);
    },
    stop: async () => {
      calls.push("stop");
      server = serverState({ status: "stopped" });
      return ok(server);
    },
  };
  return {
    port,
    calls,
    inputs,
    settleInput: async (outcome: ComputerViewerOutcome<void> = ok(undefined)) => {
      const current = pendingInput;
      pendingInput = null;
      current?.resolve(outcome);
      await Promise.resolve();
      await Promise.resolve();
    },
    setServer: (next: ComputerState) => {
      server = next;
    },
  };
}

const click = (x: number): ComputerAction => ({ _tag: "click", x, y: 1, button: "left" });

describe("computer viewer controller", () => {
  it("takes control, sends input in order, and returns control", async () => {
    const fake = fakePort();
    const controller = createComputerViewerController({ port: fake.port });
    await controller.show();
    expect(deriveComputerViewer(controller.getState()).owner).toBe("bot");

    await controller.takeControl();
    expect(deriveComputerViewer(controller.getState()).owner).toBe("you");

    controller.sendInput(click(1));
    controller.sendInput(click(2));
    expect(fake.inputs).toEqual([{ sequence: 1, action: click(1) }]);
    await fake.settleInput();
    expect(fake.inputs.at(-1)).toEqual({ sequence: 2, action: click(2) });
    await fake.settleInput();
    expect(controller.getState().lease?.sequence).toBe(2);

    await controller.returnControl();
    expect(fake.calls).toContain("release");
    expect(deriveComputerViewer(controller.getState()).owner).toBe("bot");
    controller.sendInput(click(3));
    expect(fake.inputs).toHaveLength(2);
  });

  it("stops the computer and resumes it through open", async () => {
    const fake = fakePort();
    let reopened = 0;
    const controller = createComputerViewerController({
      port: fake.port,
      onReopened: () => reopened++,
    });
    await controller.show();
    await controller.takeControl();
    await controller.stop();
    expect(deriveComputerViewer(controller.getState())).toMatchObject({
      phase: "stopped",
      owner: "nobody",
      canResume: true,
    });
    await controller.resume();
    expect(reopened).toBe(1);
    expect(deriveComputerViewer(controller.getState())).toMatchObject({
      phase: "live",
      owner: "bot",
    });
  });

  it("gives up a stale lease when input is rejected and never replays it", async () => {
    const fake = fakePort();
    const controller = createComputerViewerController({ port: fake.port });
    await controller.show();
    await controller.takeControl();
    controller.sendInput(click(1));
    controller.sendInput(click(2));
    fake.setServer(serverState({ status: "stopped" }));
    await fake.settleInput({ ok: false, code: "revoked" });
    await Promise.resolve();
    expect(fake.inputs).toHaveLength(1);
    expect(fake.calls).toContain("release");
    expect(controller.getState().notice).toBe("revoked");
    expect(deriveComputerViewer(controller.getState())).toMatchObject({
      phase: "stopped",
      owner: "nobody",
    });
  });

  it("hands a lease the server still holds back to the bot after a rejected input", async () => {
    const fake = fakePort();
    const controller = createComputerViewerController({ port: fake.port });
    await controller.show();
    await controller.takeControl();
    controller.sendInput(click(1));
    await fake.settleInput({ ok: false, code: "sequence" });
    await Promise.resolve();
    expect(fake.calls.filter((call) => call === "release")).toHaveLength(1);
    expect(controller.getState().lease).toBeNull();
    expect(deriveComputerViewer(controller.getState())).toMatchObject({
      phase: "live",
      owner: "bot",
    });
  });

  it("hands the lease back when an input request fails in transport", async () => {
    const fake = fakePort();
    const controller = createComputerViewerController({ port: fake.port });
    await controller.show();
    await controller.takeControl();
    controller.sendInput(click(1));
    await fake.settleInput({ ok: false, code: "transport" });
    await Promise.resolve();
    expect(fake.calls.filter((call) => call === "release")).toHaveLength(1);
    expect(controller.getState().lease).toBeNull();
  });

  it("expires control on the lease deadline", async () => {
    const fake = fakePort();
    const controller = createComputerViewerController({ port: fake.port });
    await controller.show();
    await controller.takeControl();
    controller.dispatch({ type: "tick", now: 60_000 });
    expect(controller.getState().notice).toBe("expired");
    controller.sendInput(click(1));
    expect(fake.inputs).toHaveLength(0);
  });

  it("closes on hide and hands back control acquired after hiding", async () => {
    const fake = fakePort();
    const controller = createComputerViewerController({ port: fake.port });
    await controller.show();
    const taking = controller.takeControl();
    await controller.hide();
    await taking;
    expect(fake.calls).toEqual(["getState", "acquire", "close", "release"]);
    expect(deriveComputerViewer(controller.getState()).phase).toBe("hidden");
  });

  it("finishes closing before a reopened viewer acquires control", async () => {
    const fake = fakePort();
    const close = deferred<void>();
    const controller = createComputerViewerController({
      port: {
        ...fake.port,
        close: async () => {
          fake.calls.push("close");
          await close.promise;
          return ok(serverState());
        },
      },
    });
    await controller.show();
    const hiding = controller.hide();
    const reopening = controller.show();
    const taking = controller.takeControl();
    expect(fake.calls).toEqual(["getState", "close"]);

    close.resolve();
    await Promise.all([hiding, reopening, taking]);
    expect(fake.calls).toEqual(["getState", "close", "getState", "acquire"]);
    expect(deriveComputerViewer(controller.getState()).owner).toBe("you");
  });

  it("releases an old acquisition that completes after reopening", async () => {
    const fake = fakePort();
    const oldAcquire = deferred<ComputerViewerOutcome<ComputerSession>>();
    let acquireCount = 0;
    const controller = createComputerViewerController({
      port: {
        ...fake.port,
        acquire: () => {
          acquireCount += 1;
          return acquireCount === 1 ? oldAcquire.promise : fake.port.acquire();
        },
      },
    });
    await controller.show();
    const taking = controller.takeControl();
    await controller.hide();
    await controller.show();
    oldAcquire.resolve(
      ok({
        sessionId: "old-lease",
        expiresAt: 60_000,
        state: serverState({ status: "human" }),
      }),
    );
    await taking;
    expect(fake.calls).toContain("release");
    expect(deriveComputerViewer(controller.getState()).owner).toBe("bot");

    await controller.takeControl();
    expect(deriveComputerViewer(controller.getState()).owner).toBe("you");
  });

  it("ignores stream events while hidden", () => {
    const controller = createComputerViewerController({ port: fakePort().port });
    controller.receive({ _tag: "state", state: serverState({ status: "human" }) });
    expect(controller.getState().server).toBeNull();
  });

  it("bounds queued input and coalesces scrolling", async () => {
    const fake = fakePort();
    const controller = createComputerViewerController({ port: fake.port });
    await controller.show();
    await controller.takeControl();
    controller.sendInput(click(0));
    controller.sendInput({ _tag: "scroll", direction: "down", amount: 100 });
    controller.sendInput({ _tag: "scroll", direction: "down", amount: 100 });
    for (let index = 0; index < COMPUTER_VIEWER_INPUT_QUEUE_LIMIT * 2; index++) {
      controller.sendInput({ _tag: "move", x: index, y: 0 });
    }
    let sent = 1;
    while (fake.inputs.length === sent) {
      await fake.settleInput();
      if (fake.inputs.length === sent) break;
      sent = fake.inputs.length;
    }
    expect(fake.inputs[1]?.action).toEqual({ _tag: "scroll", direction: "down", amount: 200 });
    expect(fake.inputs.length).toBeLessThanOrEqual(COMPUTER_VIEWER_INPUT_QUEUE_LIMIT + 1);
    expect(fake.inputs.map((input) => input.sequence)).toEqual(
      fake.inputs.map((_, index) => index + 1),
    );
  });
});
