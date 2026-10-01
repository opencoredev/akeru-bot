import { ThreadId, type ProviderRuntimeEvent } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeDrainableWorker } from "@akeru/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@akeru/shared/git";
import type { createContext } from "./Context.ts";
import type { createDependencies } from "./Dependencies.ts";
export const createWorkspace = Effect.fn("makecheckpoint-reactor-Workspace")(function* ({
  resolveSessionRuntimeForThread,
  git,
  projectionSnapshotQuery,
  orchestrationEngine,
  serverCommandId,
}: Pick<
  ReturnType<typeof createContext> & Effect.Success<ReturnType<typeof createDependencies>>,
  | "resolveSessionRuntimeForThread"
  | "git"
  | "projectionSnapshotQuery"
  | "orchestrationEngine"
  | "serverCommandId"
>) {
  const followBranchFromTurnCompletion = Effect.fn("followBranchFromTurnCompletion")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>,
  ) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const checkedOutBranch = yield* git.statusDetailsLocal(sessionRuntime.value.cwd).pipe(
      Effect.map((details) => (details.isRepo ? details.branch : null)),
      Effect.catch((error) =>
        Effect.logWarning("failed to read the worktree branch after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    yield* followWorktreeBranchDrift({
      threadId: event.threadId,
      cwd: sessionRuntime.value.cwd,
      checkedOutBranch,
    });
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses T3's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly checkedOutBranch: string | null;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.checkedOutBranch;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd ||
        isTemporaryWorktreeBranch(thread.branch)
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("failed to follow worktree branch drift", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  // Reading the worktree branch shells out to git. Run it on its own worker so
  // file capture for this turn (and checkpoints for other threads) never wait
  // behind that work.
  const statusRefreshWorker = yield* makeDrainableWorker(
    (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) =>
      followBranchFromTurnCompletion(event).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("failed to follow the worktree branch after turn completion", {
                threadId: event.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );
  return { followBranchFromTurnCompletion, followWorktreeBranchDrift, statusRefreshWorker };
});
