import { type ChatAttachment, type ProjectId, ThreadId } from "@akeru/contracts";
import { isTemporaryWorktreeBranch } from "@akeru/shared/git";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { buildGeneratedWorktreeBranchName } from "./Fields.ts";
import type { createDependencies } from "./Dependencies.ts";

export function createWorkspace({
  projectionSnapshotQuery,
  fileSystem,
  gitWorkflow,
  serverSettingsService,
  textGeneration,
  orchestrationEngine,
  serverCommandId,
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>>,
  | "projectionSnapshotQuery"
  | "fileSystem"
  | "gitWorkflow"
  | "serverSettingsService"
  | "textGeneration"
  | "orchestrationEngine"
  | "serverCommandId"
>) {
  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Recreates a thread's worktree from its branch when the directory has
   * disappeared. Provider sessions resume into the persisted cwd, so a missing
   * worktree makes every later turn fail as a bogus "session not found".
   * Best-effort: on failure the turn proceeds and reports the real error.
   */
  const ensureThreadWorktree = Effect.fnUntraced(function* (thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) {
    const { worktreePath, branch } = thread;

    if (!worktreePath || !branch) {
      return;
    }

    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));

    if (exists) {
      return;
    }

    const project = yield* resolveProject(thread.projectId);

    if (!project) {
      return;
    }

    const cwd = project.workspaceRoot;
    yield* Effect.logWarning("provider command reactor recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    // A directory deleted without `git worktree remove` leaves an admin entry
    // that makes `git worktree add` refuse the path; prune clears it.
    yield* gitWorkflow.pruneWorktrees({ cwd }).pipe(
      Effect.andThen(gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath })),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("provider command reactor failed to recreate worktree", {
              threadId: thread.id,
              worktreePath,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }

    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      // The branch-name model override retired with Settings > Source Control;
      // generated branch names use the default text generation model.
      const { textGenerationModelSelection: modelSelection } =
        yield* serverSettingsService.getSettings;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });

      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);

      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  return { resolveProject, ensureThreadWorktree, maybeGenerateAndRenameWorktreeBranchForFirstTurn };
}
