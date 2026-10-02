import {
  AuthSessionId,
  CommandId,
  MessageId,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  ThreadId,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor.ts";
import { RoutineRuntime } from "./routines/Runtime.ts";
import { defaultModelSelection, defaultProjectId } from "./serverTestFixtures.ts";
import { ServerRuntimeStartup } from "./startupCommandGate.ts";
import { createWsOrchestrationCommands } from "./wsOrchestrationCommands.ts";

const stages = [
  "create",
  "fence",
  "remote",
  "fetch",
  "resolve",
  "worktree",
  "meta",
  "turn",
] as const;

// Engine dispatches commit even when the caller is interrupted, so a blocked
// dispatch models a committed command whose result arrives after cancellation.
const committedStages: ReadonlySet<string> = new Set(["create", "meta", "turn"]);

const makeBootstrap = Effect.fn("makeBootstrap")(function* (
  blockedStage?: (typeof stages)[number],
) {
  const trace: string[] = [];
  const blocked = yield* Deferred.make<void>();

  const release = yield* Deferred.make<void>();

  const operation = Effect.fn("bootstrapOperation")(function* <A>(name: string, value: A) {
    trace.push(name);

    if (name === blockedStage) {
      yield* Deferred.succeed(blocked, undefined);

      if (committedStages.has(name)) {
        yield* Deferred.await(release);

        return value;
      }

      return yield* Effect.never;
    }

    return value;
  });

  const dispatch = (command: OrchestrationCommand) =>
    operation(
      Match.value(command.type).pipe(
        Match.when("thread.create", () => "create"),
        Match.when("thread.delete", () => "delete"),
        Match.when("thread.meta.update", () => "meta"),
        Match.orElse(() => "turn"),
      ),
      { sequence: trace.length + 1 },
    );

  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({ dispatch }),
    Layer.mock(ThreadDeletionReactor)({ drainThrough: () => operation("fence", undefined) }),
    Layer.mock(GitWorkflowService)({
      remoteExists: () => operation("remote", true),
      fetchRemote: () => operation("fetch", undefined),
      resolveRemoteTrackingCommit: () =>
        operation("resolve", { commitSha: "commit", remoteRefName: "origin/main" }),
      createWorktree: () =>
        operation("worktree", { worktree: { path: "/tmp/bootstrap", refName: "bootstrap" } }),
    }),
    Layer.mock(RoutineRuntime)({}),
    Layer.mock(ServerRuntimeStartup)({}),
  );

  const program = Effect.gen(function* () {
    const commands = createWsOrchestrationCommands({
      orchestrationEngine: yield* OrchestrationEngineService,
      threadDeletionReactor: yield* ThreadDeletionReactor,
      gitWorkflow: yield* GitWorkflowService,
      routineRuntime: yield* RoutineRuntime,
      startup: yield* ServerRuntimeStartup,
      hasClientOrigin: false,
      clientOrigin: {},
      dispatchActor: { personId: AuthSessionId.make("bootstrap-test"), canManageGroups: true },
      dispatchFromClient: dispatch,
      serverCommandId: (name) => Effect.succeed(CommandId.make(name)),
      toDispatchCommandError: (cause, message) =>
        new OrchestrationDispatchCommandError({ message, cause }),
      toBootstrapDispatchCommandCauseError: (cause) =>
        new OrchestrationDispatchCommandError({ message: "Bootstrap failed", cause }),
    });

    return yield* commands.dispatchBootstrapTurnStart({
      type: "thread.turn.start",
      commandId: CommandId.make("bootstrap-start"),
      threadId: ThreadId.make("bootstrap-thread"),
      message: {
        messageId: MessageId.make("bootstrap-message"),
        role: "user",
        text: "hello",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      bootstrap: {
        createThread: {
          projectId: defaultProjectId,
          title: "Bootstrap",
          modelSelection: defaultModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        prepareWorktree: {
          projectCwd: "/tmp/bootstrap-project",
          baseBranch: "main",
          branch: "bootstrap",
          startFromOrigin: true,
        },
      },
    });
  }).pipe(Effect.provide(dependencies));

  return { program, trace, blocked, release };
});

for (const stage of stages) {
  const expectedTrace =
    stage === "turn" ? [...stages] : [...stages.slice(0, stages.indexOf(stage) + 1), "delete"];

  it.effect(`cleans up only an unaccepted bootstrap cancelled at ${stage}`, () =>
    Effect.gen(function* () {
      const { program, trace, blocked, release } = yield* makeBootstrap(stage);
      const fiber = yield* Effect.forkChild(program);
      yield* Deferred.await(blocked);
      const interruptor = yield* Effect.fiberId;
      const interrupting = yield* Effect.forkChild(Fiber.interruptAs(fiber, interruptor));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupting);
      const exit = yield* Fiber.await(fiber);

      assert.isTrue(Exit.isFailure(exit));

      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
        assert.deepEqual([...Cause.interruptors(exit.cause)], [interruptor]);
      }

      assert.deepEqual(trace, expectedTrace);
    }),
  );
}

it.effect("does not delete a successfully bootstrapped thread", () =>
  Effect.gen(function* () {
    const { program, trace } = yield* makeBootstrap();
    yield* program;
    assert.deepEqual(trace, [...stages]);
  }),
);
