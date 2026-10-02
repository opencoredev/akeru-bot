import { CommandId, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { asTurnId, createProviderCommandHarness } from "./test-support/ProviderCommandHarness.ts";

describe("ProviderCommandReactor", () => {
  const testScope = createProviderCommandHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await harness.run(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await harness.run(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await harness.waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
    });
  });

  effectIt.effect(
    "stops a running session and records the failure when provider interrupt fails",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({
            interruptTurnEffect: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread.interrupt",
                  detail: "provider session disappeared",
                }),
              ),
            stopSessionEffect: () =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "session.stop",
                  detail: "provider process already exited",
                }),
              ),
          }),
        );

        const now = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-interrupt-failure"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-turn-interrupt-provider-failure"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          createdAt: now,
        });

        yield* Effect.promise(() =>
          harness.waitFor(async () => {
            const thread = (await harness.readModel()).threads.find(
              (entry) => entry.id === ThreadId.make("thread-1"),
            );

            return thread?.session?.status === "stopped";
          }),
        );

        const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
          (entry) => entry.id === ThreadId.make("thread-1"),
        );

        expect(thread?.session).toMatchObject({
          status: "stopped",
          activeTurnId: null,
          lastError: "provider session disappeared",
        });
        expect(
          thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
        ).toMatchObject({
          summary: "Provider turn interrupt failed",
          payload: { detail: "provider session disappeared" },
        });
        expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
      }),
  );

  effectIt.effect("stops a starting session without a bound turn when interrupt fails", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          interruptTurnEffect: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "codex",
                method: "thread.interrupt",
                detail: "provider session disappeared",
              }),
            ),
        }),
      );

      const now = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-interrupt-starting"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "starting",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-starting-provider-failure"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      });

      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );

      expect(thread?.session).toMatchObject({
        status: "stopped",
        activeTurnId: null,
        lastError: "provider session disappeared",
      });
      expect(harness.stopSession).toHaveBeenCalledWith({ threadId: ThreadId.make("thread-1") });
      expect(
        thread?.activities.find((activity) => activity.kind === "provider.turn.interrupt.failed"),
      ).toMatchObject({ payload: { detail: "provider session disappeared" } });
    }),
  );

  effectIt.effect("does not overwrite a session that became ready while an interrupt failed", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() => createHarness());
      const now = "2026-01-01T00:00:00.000Z";
      const completedAt = "2026-01-01T00:00:01.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-interrupt-race"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });

      harness.interruptTurn.mockImplementation(() =>
        harness.engine
          .dispatch({
            type: "thread.session.set",
            commandId: CommandId.make("cmd-session-set-natural-completion"),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: completedAt,
            },
            createdAt: completedAt,
          })
          .pipe(
            Effect.catchCause((cause) => Effect.die(cause)),
            Effect.andThen(
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "thread.interrupt",
                  detail: "provider session disappeared",
                }),
              ),
            ),
          ),
      );

      yield* harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-race"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      });

      yield* Effect.promise(() => harness.drain());

      const thread = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );

      expect(thread?.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: completedAt,
      });
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.failed"),
      ).toBe(false);
    }),
  );
});
