import { ComposioOperationError, ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { AKERU_TURN_USAGE_RESERVATION_TOKENS } from "../../usage/BotUsageLedger.ts";
import {
  asMessageId,
  createProviderCommandHarness,
} from "./test-support/ProviderCommandHarness.ts";

describe("ProviderCommandReactor", () => {
  const testScope = createProviderCommandHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  it("retries the original request when session startup failed before provider acceptance", async () => {
    let attempts = 0;

    const harness = await createHarness({
      startSessionEffect: (session) => {
        attempts += 1;

        return attempts === 1
          ? Effect.fail(
              new ProviderAdapterRequestError({
                provider: ProviderDriverKind.make("codex"),
                method: "startSession",
                detail: "not connected",
                cause: new Error("not connected"),
              }),
            )
          : Effect.succeed(session);
      },
    });

    const now = "2026-01-01T00:00:00.000Z";
    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-pre-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-pre-provider-failure"),
          role: "user",
          text: "send this only once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();
    expect(harness.sendTurn).not.toHaveBeenCalled();

    await harness.runEffect(
      harness.engine.dispatch({
        type: "thread.turn.resume",
        commandId: CommandId.make("cmd-resume-pre-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );
    await harness.drain();

    expect(harness.sendTurn).toHaveBeenCalledOnce();
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({ input: "send this only once" });
  });

  it.each([
    ["codex", "gpt-5.6-sol"],
    ["claudeAgent", "claude-fable-5"],
    ["grok", "grok-code-fast-1"],
    ["opencode", "anthropic/claude-sonnet-4-5"],
    ["kimi", "k3-256k"],
  ] as const)("routes a saved %s bot model to its provider driver", async (provider, model) => {
    const harness = await createHarness({
      botEngine: { provider, model },
    });

    const now = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-turn-start-${provider}-bot`),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId(`user-message-${provider}-bot`),
          role: "user",
          text: "use the bot engine",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await harness.waitFor(() => harness.startSession.mock.calls.length === 1);
    expect(harness.resolveEngine).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      engine: { provider, model },
      fallback: {
        instanceId: ProviderInstanceId.make(provider),
        model,
      },
      mode: "default",
      botConversation: true,
    });
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make(provider),
      providerInstanceId: ProviderInstanceId.make(provider),
      modelSelection: {
        instanceId: ProviderInstanceId.make(provider),
        model,
      },
      botSandbox: "local",
    });
  });

  effectIt.effect("reserves a configured bot's turn usage and binds the provider turn", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          botEngine: { provider: "codex", model: "gpt-5-codex" },
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-metered-bot"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-metered-bot"),
          role: "user",
          text: "meter this turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });

      yield* Effect.promise(() => harness.waitFor(() => harness.sendTurn.mock.calls.length === 1));
      yield* Effect.promise(() =>
        harness.waitFor(
          async () => (await harness.summarizeBotUsage()).entries[0]?.turnId === "turn-1",
        ),
      );
      const usage = yield* Effect.promise(() => harness.summarizeBotUsage());
      expect(usage.reservedTokens).toBe(AKERU_TURN_USAGE_RESERVATION_TOKENS);
      expect(usage.entries).toContainEqual(
        expect.objectContaining({
          botId: "bot-1",
          threadId: "thread-1",
          turnId: "turn-1",
          state: "reserved",
          reservedTokens: AKERU_TURN_USAGE_RESERVATION_TOKENS,
        }),
      );
    }),
  );

  effectIt.effect("releases a configured bot's usage reservation when dispatch fails", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          botEngine: { provider: "codex", model: "gpt-5-codex" },
        }),
      );

      harness.sendTurn.mockImplementation(() => Effect.die("dispatch failed"));

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-dispatch-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-dispatch-failure"),
          role: "user",
          text: "fail dispatch",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Effect.promise(() => harness.drain());

      const usage = yield* Effect.promise(() => harness.summarizeBotUsage());
      expect(usage.consumedTokens).toBe(0);
      expect(usage.reservedTokens).toBe(0);
      expect(usage.entries[0]?.state).toBe("released");
    }),
  );

  effectIt.effect("charges a configured bot's usage reservation when turn binding fails", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          botEngine: { provider: "codex", model: "gpt-5-codex" },
          bindTurnFailure: true,
        }),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-bind-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-bind-failure"),
          role: "user",
          text: "fail binding",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* Effect.promise(() => harness.drain());

      const usage = yield* Effect.promise(() => harness.summarizeBotUsage());
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(usage.consumedTokens).toBe(AKERU_TURN_USAGE_RESERVATION_TOKENS);
      expect(usage.reservedTokens).toBe(0);
      expect(usage.entries[0]).toMatchObject({
        state: "unavailable",
        unavailableReason: "Usage reservation could not bind to the provider turn.",
      });
    }),
  );

  it("projects a typed failure when the configured bot engine is unavailable", async () => {
    const harness = await createHarness({
      botEngine: { provider: "missing", model: "missing-model" },
      unavailableEngine: true,
    });

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-bot-engine"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-bot-engine"),
          role: "user",
          text: "use missing engine",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await harness.waitFor(() => harness.resolveEngine.mock.calls.length === 1);
    await harness.drain();

    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );

    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.turn.start.failed",
        payload: {
          detail: "Provider instance 'missing' is not available.",
          unavailability: "temporary-failure",
          requestId: "user-message-missing-bot-engine",
          providerInstanceId: "missing",
        },
      }),
    );
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("keeps a missing sign-in typed so the chat can point to Settings", async () => {
    const harness = await createHarness({
      botEngine: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      unavailableEngine: "missing-login",
    });

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-signed-out-bot-engine"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-signed-out-bot-engine"),
          role: "user",
          text: "use signed out engine",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await harness.waitFor(() => harness.resolveEngine.mock.calls.length === 1);
    await harness.drain();

    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );

    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.turn.start.failed",
        payload: {
          detail: "Connect Claude in Settings.",
          unavailability: "missing-login",
          requestId: "user-message-signed-out-bot-engine",
          providerInstanceId: "claudeAgent",
        },
      }),
    );
    expect(harness.startSession).not.toHaveBeenCalled();
  });

  it("reports a disabled engine as one readable line and names the bot on its bot work", async () => {
    const harness = await createHarness({
      botEngine: { provider: "codex", model: "gpt-5-codex" },
      disabledEngine: true,
    });

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-disabled-bot-engine"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-disabled-bot-engine"),
          role: "user",
          text: "use disabled engine",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await harness.waitFor(() => harness.failDelegation.mock.calls.length === 1);
    await harness.drain();
    const detail = "Provider instance 'codex' is disabled in Akeru Bot settings.";
    expect(harness.failDelegation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      error: `Configured bot could not start: ${detail}`,
    });

    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );

    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed")
        ?.payload,
    ).toMatchObject({ detail });
    expect(thread?.session?.lastError).toBe(detail);
  });

  it("fails the turn before provider dispatch when Composio runtime preparation fails", async () => {
    const harness = await createHarness({
      composioResolveRuntimeMcpServer: () =>
        Effect.fail(
          new ComposioOperationError({
            operation: "prepare connected tools",
            message: "Composio could not prepare connected tools.",
          }),
        ),
    });

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-composio-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-composio-failure"),
          role: "user",
          text: "check my inbox",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await harness.drain();

    const thread = (await harness.readModel()).threads.find(
      (entry) => entry.id === ThreadId.make("thread-1"),
    );

    expect(thread?.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.turn.start.failed",
        payload: {
          detail: "Composio could not prepare connected tools.",
          unavailability: "temporary-failure",
          requestId: "user-message-composio-failure",
        },
      }),
    );
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  effectIt.effect("projects starting before a slow provider session finishes", () =>
    Effect.gen(function* () {
      const releaseStart = yield* Deferred.make<void>();

      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) => Deferred.await(releaseStart).pipe(Effect.as(session)),
        }),
      );

      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-slow-provider"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-slow-provider"),
          role: "user",
          text: "start slowly",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        harness.waitFor(() => harness.startSession.mock.calls.length === 1),
      );
      const duringStartup = yield* Effect.promise(() => harness.readModel());
      expect(
        duringStartup.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
          ?.status,
      ).toBe("starting");
      expect(harness.sendTurn).not.toHaveBeenCalled();

      yield* Deferred.succeed(releaseStart, undefined);
      yield* Effect.promise(() => harness.waitFor(() => harness.sendTurn.mock.calls.length === 1));
    }),
  );

  effectIt.effect("settles a failed provider startup and allows a clean retry", () =>
    Effect.gen(function* () {
      let failStartup = true;

      const harness = yield* Effect.promise(() =>
        createHarness({
          startSessionEffect: (session) =>
            failStartup
              ? Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: "codex",
                    method: "thread.start",
                    detail: "deterministic startup failure",
                  }),
                )
              : Effect.succeed(session),
        }),
      );

      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-failure"),
          role: "user",
          text: "fail once",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      });

      yield* Effect.promise(() =>
        harness.waitFor(async () => {
          const readModel = await harness.readModel();

          return (
            readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.session
              ?.status === "error"
          );
        }),
      );
      let readModel = yield* Effect.promise(() => harness.readModel());
      let thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.lastError).toContain("deterministic startup failure");
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
      ).toMatchObject({
        payload: {
          detail: "deterministic startup failure",
          requestId: "user-message-provider-failure",
        },
      });
      expect(harness.sendTurn).not.toHaveBeenCalled();

      failStartup = false;
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-retry"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-retry"),
          role: "user",
          text: "retry",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      });

      yield* Effect.promise(() => harness.waitFor(() => harness.sendTurn.mock.calls.length === 1));
      readModel = yield* Effect.promise(() => harness.readModel());
      thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.session?.status).toBe("starting");
      expect(thread?.session?.lastError).toBeNull();
    }),
  );
});
