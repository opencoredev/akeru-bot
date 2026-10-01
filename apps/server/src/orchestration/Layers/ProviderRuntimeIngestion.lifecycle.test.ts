import { ProviderDriverKind } from "@akeru/contracts";
import { BotId, CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@akeru/contracts";
import * as ChannelRuntime from "../../channels/ChannelRuntime.ts";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { forkParked } from "../../serverActivation.ts";
import {
  asProjectId,
  asTurnId,
  asEventId,
  asThreadId,
  waitForThread,
  asMessageId,
  createRuntimeIngestionHarness,
} from "./test-support/RuntimeIngestionHarness.ts";

describe("ProviderRuntimeIngestion", () => {
  const testScope = createRuntimeIngestionHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  it.each(["slack", "discord"] as const)(
    "serializes slow accepted updates before terminal %s status",
    async (provider) => {
      const harness = await createHarness({ botOwned: true });
      const accepted = Promise.withResolvers<void>();
      const releaseAccepted = Promise.withResolvers<void>();
      const terminalPersisted = Promise.withResolvers<void>();
      const signals = new Set<string>();

      const channel = await harness.connectChannel(async () => {}, provider, {
        add: async (_thread, _message, emoji) => {
          if (emoji === "eyes") {
            accepted.resolve();
            await releaseAccepted.promise;
          }

          signals.add(emoji);
        },
        remove: async (_thread, _message, emoji) => {
          signals.delete(emoji);
        },
      });

      const threadId = ChannelRuntime.channelThreadId(
        BotId.make("bot-akeru"),
        asProjectId("project-1"),
        provider,
        `${provider}:race`,
      );

      await harness.run(
        forkParked(
          Stream.runForEach(harness.engine.streamDomainEvents, (event) =>
            Effect.sync(() => {
              if (
                event.type === "thread.session-set" &&
                event.payload.threadId === threadId &&
                event.payload.session.status === "ready"
              )
                terminalPersisted.resolve();
            }),
          ),
        ).pipe(Scope.provide(testScope.scope!)),
      );

      const inbound = channel.inbound({
        externalThreadId: `${provider}:race`,
        externalMessageId: "race-request",
        text: "Question",
      });

      await accepted.promise;

      const base = {
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: asTurnId("race-turn"),
        createdAt: "2026-01-01T00:00:02.000Z",
      };

      try {
        harness.emit({
          ...base,
          eventId: asEventId("race-started"),
          type: "turn.started",
          payload: {},
        });
        await harness.drain();
        harness.emit({
          ...base,
          eventId: asEventId("race-completed"),
          type: "turn.completed",
          payload: { state: "completed" },
        });
        await terminalPersisted.promise;
        expect([...signals]).toEqual([]);
      } finally {
        releaseAccepted.resolve();
      }

      await inbound;
      await harness.drain();
      expect([...signals]).toEqual(["check"]);
      await harness.shutdownChannels();
      expect([...signals]).toEqual([]);
    },
  );

  it.each(
    (["slack", "discord", "telegram"] as const).flatMap((provider) =>
      (["completed", "failed", "cancelled", "aborted", "exited", "error", "stopped"] as const).map(
        (state) => ({ provider, state }),
      ),
    ),
  )(
    "clears accepted status through shipped ingestion: $provider $state",
    async ({ provider, state }) => {
      const harness = await createHarness({ botOwned: true });
      const signals = new Set<string>();
      const calls: string[] = [];
      const posts: string[] = [];

      const channel = await harness.connectChannel(
        async (_target, text) => {
          posts.push(text);
        },
        provider,
        {
          add: async (_thread, _message, emoji) => {
            signals.add(emoji);
            calls.push(`add:${emoji}`);
          },
          remove: async (_thread, _message, emoji) => {
            signals.delete(emoji);
            calls.push(`remove:${emoji}`);
          },
        },
      );

      const message = {
        externalThreadId: `${provider}:owner`,
        externalMessageId: "request-1",
        text: "Question",
      };

      await channel.inbound(message);
      expect([...signals]).toEqual(provider === "telegram" ? [] : ["eyes"]);

      const threadId = ChannelRuntime.channelThreadId(
        BotId.make("bot-akeru"),
        asProjectId("project-1"),
        provider,
        message.externalThreadId,
      );

      const turnId = asTurnId("status-turn");

      const base = {
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId,
        createdAt: "2026-01-01T00:00:02.000Z",
      };

      harness.emit({
        ...base,
        eventId: asEventId("status-started"),
        type: "turn.started",
        payload: {},
      });
      await harness.drain();

      const terminal =
        state === "aborted"
          ? {
              ...base,
              eventId: asEventId("status-terminal"),
              type: "turn.aborted" as const,
              payload: { reason: "cancelled" },
            }
          : state === "exited"
            ? {
                ...base,
                eventId: asEventId("status-terminal"),
                type: "session.exited" as const,
                payload: {},
              }
            : state === "error" || state === "stopped"
              ? {
                  ...base,
                  eventId: asEventId("status-terminal"),
                  type: "session.state.changed" as const,
                  payload: { state } as const,
                }
              : {
                  ...base,
                  eventId: asEventId("status-terminal"),
                  type: "turn.completed" as const,
                  payload: { state } as const,
                };

      harness.emit(terminal);
      await harness.drain();
      expect([...signals]).toEqual(
        provider === "telegram" ? [] : [state === "completed" ? "check" : "x"],
      );
      expect(posts).toEqual(
        state === "completed" ? ["I finished without a text response. Please try again."] : [],
      );
      const completedCalls = [...calls];
      harness.emit({ ...terminal, eventId: asEventId("status-terminal-replay") });
      await harness.drain();
      await channel.inbound(message);
      expect(calls).toEqual(completedCalls);
      await harness.disconnectChannel(BotId.make("bot-akeru"), provider);
      expect([...signals]).toEqual([]);

      if (provider === "telegram") expect(calls).toEqual([]);
    },
  );

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );

    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
      status: "completed",
    });

    await waitForThread(
      harness,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("rejects an untargeted turn.completed when no turn is active", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    // A turn start is pending: the session reads "starting" with no active
    // turn tracked yet. This is the window the Claude resume handshake's
    // phantom (turn.completed with no turnId) used to slip through, stomping
    // "starting" back to "ready" for a turn that never existed.
    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-seed-untargeted-completion"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "starting",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: seededAt,
        lastError: null,
      },
      createdAt: seededAt,
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-untargeted"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: seededAt,
      threadId: asThreadId("thread-1"),
      status: "completed",
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.status).toBe("starting");
    expect(thread?.session?.activeTurnId).toBeNull();
  });

  it("accepts a targeted turn.completed when no turn is active", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    // A completion that names its turn still lands even when no active turn
    // is tracked (e.g. its turn.started was lost). Only untargeted
    // completions are rejected.
    await harness.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-seed-targeted-completion"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "starting",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: seededAt,
        lastError: null,
      },
      createdAt: seededAt,
    });

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-targeted-late"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: seededAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-late"),
      status: "completed",
    });

    await waitForThread(harness, (thread) => thread.session?.status === "ready");
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
    });

    await waitForThread(
      harness,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-other"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-guarded-main"),
      status: "completed",
    });

    await waitForThread(
      harness,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("accepts a conflicting turn.started for a pending turn start when the provider expects that turn", async () => {
    // Steering a running turn: the server requests a new turn while the old
    // one is still active, and providers like opencode open the new turn
    // without ever completing the superseded one. The new turn.started must
    // replace the active turn instead of being rejected as stale.
    const harness = await createHarness();
    const threadId = asThreadId("thread-1");
    const oldTurnId = asTurnId("turn-steered-over");
    const newTurnId = asTurnId("turn-from-steer");
    const createdAt = "2026-01-01T00:00:00.000Z";

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: oldTurnId,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-steered-over"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: oldTurnId,
    });
    await waitForThread(
      harness,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === oldTurnId,
      2_000,
      threadId,
    );

    // The steer: a user-requested turn start while the old turn still runs.
    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-steer"),
        threadId,
        message: {
          messageId: asMessageId("msg-steer"),
          role: "user",
          text: "actually, do 15 instead",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    // The provider session tracks the new turn before emitting turn.started
    // (sendTurn updates the session first).
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: newTurnId,
    });
    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-from-steer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: newTurnId,
    });

    const threadAfterSteer = await waitForThread(
      harness,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === newTurnId,
      2_000,
      threadId,
    );

    expect(threadAfterSteer.session?.activeTurnId).toBe(newTurnId);
    expect(threadAfterSteer.latestTurn?.turnId).toBe(newTurnId);
    expect(threadAfterSteer.latestTurn?.state).toBe("running");
  });
});
