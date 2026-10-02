import { assert, it } from "@effect/vitest";
import { ThreadId, TurnId } from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  AkeruWorkerError,
  type AkeruWorkerParent,
  type AkeruWorkerPort,
  makeAkeruWorkerRuntime,
} from "./AkeruWorkerRuntime.ts";
import { AgentControllerRuntimeError } from "./Errors.ts";
import { createWorkers } from "./Layers/agentController/Workers.ts";

const parent: AkeruWorkerParent = {
  threadId: ThreadId.make("parent-thread"),
  turnId: TurnId.make("parent-turn"),
  depth: 0,
  access: {
    allowedToolIds: [],
    memoryScopes: [],
    sandbox: null,
    runtimeMode: "full-access",
    hasUserComputer: false,
    enabledMcpServerIds: [],
    disabledMcpServerIds: [],
    approvalCeiling: "none",
  },
};

for (const stage of ["creation", "dispatch"] as const) {
  for (const detail of ["", " \n "]) {
    it.effect(
      `settles ${stage} errors with detail ${JSON.stringify(detail)} and frees the slot`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const gate = yield* Deferred.make<void>();
            const discarded: ThreadId[] = [];
            const childThreadId = ThreadId.make("child-thread");

            const failure = Deferred.await(gate).pipe(
              Effect.andThen(Effect.fail(new AkeruWorkerError({ reason: "start_failed", detail }))),
            );

            const port: AkeruWorkerPort = {
              createChild: () => (stage === "creation" ? failure : Effect.succeed(childThreadId)),
              messageChild: () => (stage === "dispatch" ? failure : Effect.void),
              interruptChild: () => Effect.void,
              discardChild: (id) => Effect.sync(() => void discarded.push(id)),
            };

            let ids = 0;

            const runtime = yield* makeAkeruWorkerRuntime(port, {
              maxConcurrency: 1,
              makeId: () => String(++ids),
            });

            const running = yield* runtime.spawn(parent, { task: "Fail", background: true });

            const waiting = yield* Effect.forkChild(
              runtime.check(parent, { workerId: running.workerId, wait: true }),
            );

            yield* Deferred.succeed(gate, undefined);
            const status = yield* Fiber.join(waiting);
            assert.deepInclude(status.phase, {
              _tag: "Failed",
              failureCode: "internal",
              message: "The worker could not start.",
              childThreadId: stage === "creation" ? null : childThreadId,
            });
            assert.deepStrictEqual(discarded, stage === "dispatch" ? [childThreadId] : []);
            assert.isUndefined(runtime.accessForThread(childThreadId));
            const foreground = yield* runtime.spawn(parent, { task: "Fail again" });
            assert.deepInclude(foreground.phase, {
              _tag: "Failed",
              message: "The worker could not start.",
            });
          }),
        ),
    );
  }
}

it.effect("settles an empty error from the production worker orchestration port", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reads = 0;

      const { workerRuntime } = yield* createWorkers({
        runMastra: (operation, run) =>
          Effect.tryPromise({
            try: run,
            catch: (cause) =>
              new AgentControllerRuntimeError({
                operation,
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }),
        wired: () => ({
          workerOrchestration: {
            readSnapshot: async () => {
              reads += 1;
              throw new Error();
            },
            dispatch: async () => assert.fail("Creation failed before dispatch"),
          },
        }),
        sessions: new Map(),
        workerTurnDefaults: new Map(),
        runPromise: Effect.runPromise,
      });

      const status = yield* workerRuntime.spawn(parent, { task: "Fail to read snapshot" });
      assert.strictEqual(reads, 1);
      assert.deepInclude(status.phase, {
        _tag: "Failed",
        childThreadId: null,
        failureCode: "internal",
        message: "The worker could not start.",
      });
      const waited = yield* workerRuntime.check(parent, { workerId: status.workerId, wait: true });
      assert.deepStrictEqual(waited, status);
    }),
  ),
);
