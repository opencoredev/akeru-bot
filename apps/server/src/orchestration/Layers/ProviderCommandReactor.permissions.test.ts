import { ComposioOperationError, type McpServer, ProviderInstanceId } from "@akeru/contracts";
import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import {
  asMessageId,
  createProviderCommandHarness,
} from "./test-support/ProviderCommandHarness.ts";

describe("ProviderCommandReactor", () => {
  const testScope = createProviderCommandHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await harness.waitFor(() => harness.startSession.mock.calls.length === 1);
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await harness.run(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await harness.waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));

      return thread?.runtimeMode === "approval-required";
    });
    await harness.waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("stops a full-access session when a restrictive runtime mode update fails", async () => {
    let failComposioPreparation = false;

    const harness = await createHarness({
      composioResolveRuntimeMcpServer: () =>
        failComposioPreparation
          ? Effect.fail(
              new ComposioOperationError({
                operation: "prepare connected tools",
                message: "Composio could not prepare connected tools.",
              }),
            )
          : Effect.succeed<McpServer | undefined>(undefined),
    });

    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-full-access-before-composio-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-composio-mode-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-composio-mode-failure"),
          role: "user",
          text: "start with full access",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);

    failComposioPreparation = true;
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restricted-after-composio-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.interruptTurn).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
    expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
    expect(harness.runtimeSessions).toHaveLength(0);

    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );

    expect(thread?.runtimeMode).toBe("approval-required");
    expect(thread?.session).toMatchObject({
      status: "error",
      activeTurnId: null,
      lastError: "Composio could not prepare connected tools.",
    });
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.session.update.failed",
        payload: {
          detail: "Composio could not prepare connected tools.",
        },
      }),
    );
  });

  it("quarantines a full-access session until restrictive cleanup is confirmed", async () => {
    let failComposioPreparation = false;
    let failSessionStop = true;

    const providerFailure = (method: string, detail: string) =>
      new ProviderAdapterRequestError({
        provider: "codex",
        method,
        detail,
      });

    const harness = await createHarness({
      composioResolveRuntimeMcpServer: () =>
        failComposioPreparation
          ? Effect.fail(
              new ComposioOperationError({
                operation: "prepare connected tools",
                message: "Composio could not prepare connected tools.",
              }),
            )
          : Effect.succeed<McpServer | undefined>(undefined),
      interruptTurnEffect: () =>
        Effect.fail(providerFailure("thread.turn.interrupt", "Interrupt failed.")),
      stopSessionEffect: () =>
        failSessionStop
          ? Effect.fail(providerFailure("thread.session.stop", "Stop failed."))
          : Effect.void,
    });

    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-quarantine-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-quarantine-start"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-quarantine-start"),
          role: "user",
          text: "start with full access",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);

    failComposioPreparation = true;
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-quarantine-restrict"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.runtimeSessions).toHaveLength(1);
    expect(harness.stopSession).toHaveBeenCalledTimes(1);

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-quarantine-blocked-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-quarantine-blocked-turn"),
          role: "user",
          text: "do not send this while cleanup is pending",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.stopSession).toHaveBeenCalledTimes(2);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    expect(harness.startSession).toHaveBeenCalledTimes(1);

    failSessionStop = false;
    failComposioPreparation = false;
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-quarantine-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.runtimeSessions).toHaveLength(0);
    expect(harness.stopSession).toHaveBeenCalledTimes(3);
    expect(
      (await harness.readModel()).threads.find((thread) => thread.id === ThreadId.make("thread-1"))
        ?.session?.status,
    ).toBe("stopped");

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-quarantine-reconciled-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-quarantine-reconciled-turn"),
          role: "user",
          text: "continue after cleanup",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.runtimeSessions).toHaveLength(1);
    expect(harness.runtimeSessions[0]?.runtimeMode).toBe("approval-required");
    expect(harness.stopSession).toHaveBeenCalledTimes(3);
    expect(harness.startSession).toHaveBeenCalledTimes(2);
  });

  it("accepts an interrupt that already removed the unrestricted session", async () => {
    let failComposioPreparation = false;

    const harness = await createHarness({
      composioResolveRuntimeMcpServer: () =>
        failComposioPreparation
          ? Effect.fail(
              new ComposioOperationError({
                operation: "prepare connected tools",
                message: "Composio could not prepare connected tools.",
              }),
            )
          : Effect.succeed<McpServer | undefined>(undefined),
      interruptTurnRemovesSession: true,
    });

    const now = "2026-01-01T00:00:00.000Z";

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-interrupt-removes-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-interrupt-removes-start"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-interrupt-removes-start"),
          role: "user",
          text: "start with full access",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);

    failComposioPreparation = true;
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-interrupt-removes-restrict"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.runtimeSessions).toHaveLength(0);
    expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
    expect(harness.stopSession).not.toHaveBeenCalled();

    failComposioPreparation = false;
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-interrupt-removes-restricted-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-interrupt-removes-restricted-turn"),
          role: "user",
          text: "continue with approval required",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.runtimeSessions).toHaveLength(1);
    expect(harness.runtimeSessions[0]?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const now = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.run(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await harness.waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("stops the active session when a restrictive restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await harness.waitFor(() => harness.startSession.mock.calls.length === 1);
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);

    harness.startSession.mockImplementationOnce(
      () => Effect.fail("simulated restart failure") as never,
    );

    await harness.run(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await harness.waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));

      return thread?.runtimeMode === "approval-required";
    });
    await harness.waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
    expect(harness.sendTurn.mock.calls.length).toBe(1);
    expect(harness.runtimeSessions).toHaveLength(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
    expect(thread?.session?.status).toBe("error");
    expect(thread?.activities).toContainEqual(
      expect.objectContaining({ kind: "provider.session.update.failed" }),
    );
  });
});
