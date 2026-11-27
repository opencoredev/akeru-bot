import { ComposioOperationError, ProviderInstanceId } from "@akeru/contracts";
import {
  BotId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { afterEach, assert, describe, expect, it } from "vite-plus/test";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
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
          : Effect.as(Effect.void, undefined),
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
          : Effect.as(Effect.void, undefined),
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
          : Effect.as(Effect.void, undefined),
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

  it("stops a session whose mode tightens while a running turn defers a workspace move", async () => {
    const harness = await createHarness({
      botEngine: { provider: "codex", model: "gpt-5.6-sol" },
      botSandboxBrowserSharing: "shared",
    });

    const threadId = ThreadId.make("thread-1");
    const now = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-full-access"),
        threadId,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-deferred-move"),
        threadId,
        message: {
          messageId: asMessageId("user-message-deferred-move"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    // The provider is still running the first turn when the bot's workspace changes.
    const sessionIndex = harness.runtimeSessions.findIndex(
      (session) => session.threadId === threadId,
    );

    const running = harness.runtimeSessions[sessionIndex];
    assert.isDefined(running);
    harness.runtimeSessions[sessionIndex] = {
      ...running,
      activeTurnId: TurnId.make("turn-running"),
    };

    const runtime = testScope.runtime;
    assert.isNotNull(runtime);
    await runtime.runPromise(
      Effect.service(ServerSettingsService).pipe(
        Effect.flatMap((settings) =>
          settings.updateSettings({ botSandboxBrowserSharing: "separate" }),
        ),
      ),
    );
    await harness.run(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-supervised"),
        threadId,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.waitFor(() => harness.stopSession.mock.calls.length === 1);

    // The turn keeps its workspace: the session stops in place instead of moving or keeping
    // Full access.
    expect(harness.interruptTurn).toHaveBeenCalled();
    expect(harness.startSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the running session's mode on record while a workspace move refuses new turns", async () => {
    const harness = await createHarness({
      botEngine: { provider: "codex", model: "gpt-5.6-sol" },
      botSandboxBrowserSharing: "shared",
    });

    const threadId = ThreadId.make("thread-1");
    const now = "2026-01-01T00:00:00.000Z";

    const startTurn = (id: string) =>
      harness.run(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-turn-start-${id}`),
          threadId,
          message: {
            messageId: asMessageId(`user-message-${id}`),
            role: "user",
            text: id,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

    const readThread = async () =>
      (await harness.readModel()).threads.find((entry) => entry.id === threadId);

    await harness.run(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-supervised"),
        threadId,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await startTurn("supervised");
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    // The provider is still running the first turn when the bot's workspace changes.
    const sessionIndex = harness.runtimeSessions.findIndex(
      (session) => session.threadId === threadId,
    );

    const running = harness.runtimeSessions[sessionIndex];
    assert.isDefined(running);
    harness.runtimeSessions[sessionIndex] = {
      ...running,
      activeTurnId: TurnId.make("turn-running"),
    };

    const runtime = testScope.runtime;
    assert.isNotNull(runtime);
    await runtime.runPromise(
      Effect.service(ServerSettingsService).pipe(
        Effect.flatMap((settings) =>
          settings.updateSettings({ botSandboxBrowserSharing: "separate" }),
        ),
      ),
    );
    await harness.run(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-full-access"),
        threadId,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );
    await harness.waitFor(
      async () =>
        (await readThread())?.activities.some(
          (activity) => activity.kind === "provider.session.update.failed",
        ) === true,
    );
    await startTurn("refused");
    await harness.waitFor(
      async () =>
        (await readThread())?.activities.some(
          (activity) => activity.kind === "provider.turn.start.failed",
        ) === true,
    );

    // The refused turn must not record Full access, or the next turn would skip the restart.
    expect((await readThread())?.session).toMatchObject({
      status: "error",
      runtimeMode: "approval-required",
    });
    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("restarts a Full access Claude session that a stale Supervised record hides", async () => {
    const harness = await createHarness({
      botEngine: { provider: "claudeCode", model: "claude-sonnet-5" },
    });

    const threadId = ThreadId.make("thread-1");
    const now = "2026-01-01T00:00:00.000Z";

    const startTurn = (id: string) =>
      harness.run(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-turn-start-${id}`),
          threadId,
          message: {
            messageId: asMessageId(`user-message-${id}`),
            role: "user",
            text: id,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

    await harness.run(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-supervised"),
        threadId,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await startTurn("first");
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    // The chat records Supervised, but the provider's query still runs with Full access.
    const sessionIndex = harness.runtimeSessions.findIndex(
      (session) => session.threadId === threadId,
    );

    const live = harness.runtimeSessions[sessionIndex];
    assert.isDefined(live);
    harness.runtimeSessions[sessionIndex] = { ...live, runtimeMode: "full-access" };

    await startTurn("second");
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      runtimeMode: "approval-required",
    });
  });

  it("does not queue Claude Agent work on this computer once its bot moves to a remote sandbox", async () => {
    const harness = await createHarness({
      botEngine: { provider: "claudeCode", model: "claude-sonnet-5" },
    });

    const threadId = ThreadId.make("thread-1");
    const now = "2026-01-01T00:00:00.000Z";
    const runtime = testScope.runtime;
    assert.isNotNull(runtime);

    await runtime.runPromise(
      Effect.service(ServerSettingsService).pipe(
        Effect.flatMap((settings) =>
          settings.updateSettings({
            sandbox: {
              providers: {
                e2b: { environment: [{ name: "E2B_API_KEY", value: "e2b-test", sensitive: true }] },
              },
            },
          }),
        ),
      ),
    );

    const startTurn = (id: string) =>
      harness.run(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-turn-start-${id}`),
          threadId,
          message: {
            messageId: asMessageId(`user-message-${id}`),
            role: "user",
            text: id,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

    await startTurn("local");
    await harness.waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();

    const sessionIndex = harness.runtimeSessions.findIndex(
      (session) => session.threadId === threadId,
    );

    const running = harness.runtimeSessions[sessionIndex];
    assert.isDefined(running);
    harness.runtimeSessions[sessionIndex] = {
      ...running,
      activeTurnId: TurnId.make("turn-running"),
    };

    await harness.run(
      harness.engine.dispatch({
        type: "bot.update",
        commandId: CommandId.make("cmd-bot-remote-sandbox"),
        botId: BotId.make("bot-1"),
        sandbox: "e2b",
      }),
    );
    await startTurn("remote");

    await harness.waitFor(
      async () =>
        (await harness.readModel()).threads
          .find((thread) => thread.id === threadId)
          ?.activities.some((activity) => activity.kind === "provider.turn.start.failed") === true,
    );

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });
});
