import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { type OrchestrationCommand, OrchestrationDispatchCommandError } from "@akeru/contracts";
import { tryAdmitTurnStart, type TurnStartAdmission } from "./remote/updateGate.ts";

import type { WsServices } from "./wsServices.ts";

export const createWsOrchestrationCommands = ({ routineRuntime, orchestrationEngine, threadDeletionReactor, hasClientOrigin, dispatchActor, dispatchFromClient, gitWorkflow, startup, toDispatchCommandError, serverCommandId, toBootstrapDispatchCommandCauseError, clientOrigin }: Pick<WsServices, "routineRuntime" | "orchestrationEngine" | "threadDeletionReactor" | "hasClientOrigin" | "dispatchActor" | "dispatchFromClient" | "gitWorkflow" | "startup" | "toDispatchCommandError" | "serverCommandId" | "toBootstrapDispatchCommandCauseError" | "clientOrigin">) => {


      const dispatchAdmittedBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
        admission: TurnStartAdmission,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;

          const cleanupCreatedThread = () =>
            createdThread
              ? serverCommandId("bootstrap-thread-delete").pipe(
                  Effect.flatMap((commandId) =>
                    dispatchFromClient({
                      type: "thread.delete",
                      commandId,
                      threadId: command.threadId,
                    }),
                  ),
                  Effect.as(true),
                )
              : Effect.succeed(false);

          const bootstrapProgram = Effect.gen(function* () {
            if (bootstrap?.createThread) {
              const created = yield* dispatchFromClient({
                type: "thread.create",
                commandId: yield* serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                botId: bootstrap.createThread.botId ?? null,
                groupId: bootstrap.createThread.groupId ?? null,
                title: bootstrap.createThread.title,
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              // The successful create is a fence in the engine command queue:
              // every delete for the prior incarnation committed before it.
              // Drain through that event before setup or turn start can own
              // terminals and provider sessions under the reused thread id.
              yield* threadDeletionReactor.drainThrough(created.sequence);
              createdThread = true;
            }

            if (bootstrap?.prepareWorktree) {
              let worktreeBaseRef = bootstrap.prepareWorktree.baseBranch;
              // "Start from origin" is a stored default; repos without an
              // origin remote fall back to the local base branch instead of
              // failing the whole bootstrap on `git fetch origin`.
              const startFromOrigin =
                bootstrap.prepareWorktree.startFromOrigin === true &&
                (yield* gitWorkflow.remoteExists({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  remoteName: "origin",
                }));
              if (startFromOrigin) {
                yield* gitWorkflow.fetchRemote({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  remoteName: "origin",
                });
                const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                  cwd: bootstrap.prepareWorktree.projectCwd,
                  refName: bootstrap.prepareWorktree.baseBranch,
                  fallbackRemoteName: "origin",
                });
                worktreeBaseRef = resolvedRemoteBase.commitSha;
              }
              const worktree = yield* gitWorkflow.createWorktree({
                cwd: bootstrap.prepareWorktree.projectCwd,
                refName: worktreeBaseRef,
                newRefName: bootstrap.prepareWorktree.branch,
                baseRefName: bootstrap.prepareWorktree.baseBranch,
                path: null,
              });
              targetWorktreePath = worktree.worktree.path;
              yield* dispatchFromClient({
                type: "thread.meta.update",
                commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
                threadId: command.threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
            }

            return yield* orchestrationEngine.dispatch(finalTurnStartCommand, {
              actor: dispatchActor,
              ...(hasClientOrigin ? { origin: clientOrigin } : {}),
              admission,
            });
          });

          return yield* bootstrapProgram.pipe(
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.fail(dispatchError);
              }
              return Effect.uninterruptible(cleanupCreatedThread()).pipe(
                Effect.matchCauseEffect({
                  onFailure: (cleanupCause) =>
                    Effect.logWarning("bootstrap thread cleanup failed", {
                      threadId: command.threadId,
                      detail: Cause.pretty(cleanupCause),
                    }).pipe(Effect.flatMap(() => Effect.fail(dispatchError))),
                  onSuccess: (threadDeleted) =>
                    Effect.fail(
                      threadDeleted
                        ? new OrchestrationDispatchCommandError({
                            message: dispatchError.message,
                            ...(dispatchError.cause !== undefined
                              ? { cause: dispatchError.cause }
                              : {}),
                            bootstrapThreadDisposition: "deleted",
                          })
                        : dispatchError,
                    ),
                }),
              );
            }),
          );
        });


      // The turn start is admitted before bootstrap creates the thread or its
      // worktree, and the same admission carries through the final dispatch,
      // so a server update cannot begin midway and strand those side effects.
      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.acquireUseRelease(
          Effect.sync(tryAdmitTurnStart),
          (admission) =>
            admission === null
              ? Effect.fail(
                  new OrchestrationDispatchCommandError({
                    message: "The server is installing an update. Try again in a moment.",
                  }),
                )
              : dispatchAdmittedBootstrapTurnStart(command, admission),
          (admission) => Effect.sync(() => admission?.release()),
        );


      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const baseDispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : dispatchFromClient(normalizedCommand).pipe(
                Effect.tap(({ sequence }) =>
                  // Returning from thread.create is the handoff point at which
                  // clients may start resources for the new incarnation. Use
                  // its event sequence as the exact deletion-cleanup fence.
                  normalizedCommand.type === "thread.create"
                    ? threadDeletionReactor.drainThrough(sequence)
                    : Effect.void,
                ),
                Effect.mapError((cause) =>
                  toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                ),
              );

        const dispatchEffect =
          normalizedCommand.type === "routine.run"
            ? routineRuntime.canRunNow(normalizedCommand.routineId).pipe(
                Effect.flatMap((canRun) =>
                  canRun
                    ? baseDispatchEffect
                    : Effect.fail(
                        new OrchestrationDispatchCommandError({
                          message: `Routine run '${normalizedCommand.runId}' did not start.`,
                        }),
                      ),
                ),
                Effect.flatMap((result) =>
                  routineRuntime
                    .runNow(
                      normalizedCommand.routineId,
                      normalizedCommand.runId,
                      normalizedCommand.trigger,
                    )
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.fail(
                          toDispatchCommandError(
                            Cause.squash(cause),
                            "Failed to start the routine run.",
                          ),
                        ),
                      ),
                      Effect.flatMap((run) =>
                        run === null
                          ? Effect.fail(
                              new OrchestrationDispatchCommandError({
                                message: `Routine run '${normalizedCommand.runId}' did not start.`,
                              }),
                            )
                          : Effect.succeed(result),
                      ),
                    ),
                ),
              )
            : baseDispatchEffect;

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };
return { dispatchAdmittedBootstrapTurnStart, dispatchBootstrapTurnStart, dispatchNormalizedCommand };
};
