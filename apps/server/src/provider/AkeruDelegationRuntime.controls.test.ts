import { describe } from "vite-plus/test";
import {
  AkeruDelegationProviderUnsupportedError,
  CommandId,
  DelegationId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  createAkeruDelegationRuntime,
  type AkeruDelegationChildOutcome,
} from "./AkeruDelegationRuntime.ts";
import {
  CHILD_BOT_ID,
  CHILD_TURN_ID,
  NOW,
  PARENT_BOT_ID,
  PARENT_THREAD_ID,
  PARENT_TURN_ID,
  bot,
  delegation,
  harness,
  parent,
  request,
  snapshot,
} from "./testUtils/delegationHarness.ts";

const isProviderUnsupported = Schema.is(AkeruDelegationProviderUnsupportedError);

describe("AkeruDelegationRuntime", () => {
  it("cancels children on parent interrupt, preserves kept children, and marks parent failure", async () => {
    const checks = async (mode: "cancel" | "keep" | "fail") => {
      let release!: (outcome: AkeruDelegationChildOutcome) => void;
      let nextId = 0;
      const started = Promise.withResolvers<void>();
      const test = harness();

      const runtime = createAkeruDelegationRuntime({
        readSnapshot: async () => test.state,
        dispatch: async (command) => {
          await test.dispatch(command);
        },
        awaitChild: (childThread) =>
          new Promise<AkeruDelegationChildOutcome>((resolve) => {
            release = (outcome) => {
              // Model the provider reactor: when the child ends on a turn, the
              // turn id lands on the record before the outcome is reported.
              const assignTurn =
                outcome.turnId === null
                  ? Promise.resolve()
                  : test
                      .dispatch({
                        type: "delegation.state.set",
                        commandId: CommandId.make(`test:assign-turn:${++nextId}`),
                        delegation: {
                          ...test.state.delegations.find(
                            (entry) =>
                              "childThreadId" in entry.phase &&
                              entry.phase.childThreadId === childThread,
                          )!,
                          phase: {
                            _tag: "Running",
                            childThreadId: childThread,
                            childTurnId: outcome.turnId,
                            startedAt: NOW,
                            progress: null,
                          },
                        },
                      })
                      .catch(() => undefined);

              void assignTurn.then(() => resolve(outcome));
            };

            started.resolve();
          }),
        interruptChild: async (threadId, turnId) => {
          test.interrupts.push({ threadId, turnId });
          release({ state: "failed", turnId, error: "Interrupted." });
        },
        now: () => NOW,
        id: () => String(++nextId),
      });

      await runtime.send(parent(), request() as never);
      await started.promise;
      const id = test.state.delegations[0]!.delegationId;
      await runtime.parentFinished({
        threadId: PARENT_THREAD_ID,
        turnId: PARENT_TURN_ID,
        failed: mode === "fail",
        ...(mode === "keep" ? { keep: new Set([id]) } : {}),
      });

      if (mode === "keep") {
        expect(test.interrupts).toEqual([]);
        release({ state: "completed", turnId: CHILD_TURN_ID, summary: "Kept result." });
      } else if (mode === "cancel") {
        release({ state: "failed", turnId: CHILD_TURN_ID, error: "Interrupted." });
      }

      await runtime.drain();

      return test;
    };

    const canceled = await checks("cancel");
    expect(canceled.commands.some((command) => command.type === "delegation.cancel")).toBe(true);
    expect(canceled.state.delegations.at(-1)?.phase._tag).toBe("Canceled");
    const kept = await checks("keep");
    expect(
      kept.commands.some((command) => command.type === "delegation.cancel" && command.keep),
    ).toBe(true);
    expect(kept.state.delegations.at(-1)?.phase._tag).toBe("Completed");
    expect((await checks("fail")).state.delegations.at(-1)).toMatchObject({
      phase: { _tag: "Failed", failure: { failureCode: "parent_failed" } },
    });
  });

  it("persists child cancellation for the reactor after the runtime restarts", async () => {
    const childThreadId = ThreadId.make("persisted-child");

    const active = delegation(DelegationId.make("persisted-delegation"), {
      phase: { _tag: "Running", childThreadId, childTurnId: null, startedAt: NOW, progress: null },
    });

    const test = harness(snapshot({ delegations: [active] }));

    await test.runtime.parentFinished({
      threadId: PARENT_THREAD_ID,
      turnId: PARENT_TURN_ID,
      failed: false,
    });

    expect(test.state.delegations[0]?.phase._tag).toBe("Canceled");
    expect(test.commands.at(-1)).toMatchObject({
      type: "delegation.cancel",
      delegationId: active.delegationId,
      keep: false,
    });
    expect(test.interrupts).toEqual([]);
  });

  it("leaves stopped work canceled when the child finishes afterwards", async () => {
    const test = harness();
    const child = Promise.withResolvers<AkeruDelegationChildOutcome>();
    const watchErrors: unknown[] = [];

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state,
      dispatch: test.dispatch,
      awaitChild: () => child.promise,
      interruptChild: async () => undefined,
      onWatchError: (_, cause) => watchErrors.push(cause),
      now: () => NOW,
      id: (() => {
        let value = 0;

        return () => String(++value);
      })(),
    });

    await runtime.send(parent(), request() as never);
    await runtime.stop(parent(), { botId: CHILD_BOT_ID });
    child.resolve({ state: "completed", turnId: CHILD_TURN_ID, summary: "Too late." });
    await runtime.drain();

    expect(test.state.delegations[0]?.phase._tag).toBe("Canceled");
    expect(watchErrors).toEqual([]);
  });

  it("refuses a legacy-bridge target before creating the child chat", async () => {
    const test = harness(
      snapshot({
        bots: [
          bot(PARENT_BOT_ID),
          bot(CHILD_BOT_ID, {
            name: "Legacy",
            engine: { provider: ProviderInstanceId.make("opencode"), model: "model" },
          }),
        ],
      }),
    );

    const runtime = createAkeruDelegationRuntime({
      readSnapshot: async () => test.state as OrchestrationReadModel,
      dispatch: test.dispatch,
      awaitChild: async () => ({ state: "completed", turnId: CHILD_TURN_ID, summary: "Done." }),
      interruptChild: async () => undefined,
      providerDriverKind: async (instanceId) => String(instanceId),
      now: () => NOW,
    });

    const refused = await runtime.send(parent(), request() as never).catch((cause) => cause);
    expect(isProviderUnsupported(refused)).toBe(true);
    expect(refused.message).toBe(
      "Legacy runs on the opencode provider, which cannot receive handed-off work. Do the work yourself or pick a bot on another provider.",
    );
    expect(test.commands).toEqual([]);
  });
});
