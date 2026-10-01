import type { StartThreadTurnInput } from "@akeru/client-runtime/operations";
import type { DraftThreadEnvMode } from "../../composerDraftStore";

type FirstSendTurnInput = Required<
  Pick<
    StartThreadTurnInput,
    "threadId" | "message" | "modelSelection" | "runtimeMode" | "interactionMode" | "createdAt"
  >
> &
  Pick<StartThreadTurnInput, "bootstrap">;

/** Builds the complete `thread.turn.start` input for ChatView's first-send path. */
export function buildFirstSendTurnInput(input: FirstSendTurnInput): StartThreadTurnInput {
  return {
    threadId: input.threadId,
    message: input.message,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    ...(input.bootstrap === undefined ? {} : { bootstrap: input.bootstrap }),
    createdAt: input.createdAt,
  };
}

/**
 * Builds the first-turn bootstrap for a send. A local draft always carries
 * `createThread` so the server can materialize it; `prepareWorktree` is added
 * only when a worktree send resolved its base branch. Any other send carries
 * no bootstrap.
 */
export function buildFirstSendBootstrap<CreateThread>(input: {
  isLocalDraftThread: boolean;
  baseBranchForWorktree: string | null;
  createThread: CreateThread;
  projectCwd: string;
  worktreeBranch: string;
  startFromOrigin: boolean;
}):
  | {
      createThread?: CreateThread;
      prepareWorktree?: {
        projectCwd: string;
        baseBranch: string;
        branch: string;
        startFromOrigin?: boolean;
      };
      runSetupScript?: boolean;
    }
  | undefined {
  if (!input.isLocalDraftThread && input.baseBranchForWorktree === null) {
    return undefined;
  }

  return {
    ...(input.isLocalDraftThread ? { createThread: input.createThread } : {}),
    ...(input.baseBranchForWorktree !== null
      ? {
          prepareWorktree: {
            projectCwd: input.projectCwd,
            baseBranch: input.baseBranchForWorktree,
            branch: input.worktreeBranch,
            ...(input.startFromOrigin ? { startFromOrigin: true } : {}),
          },
          runSetupScript: true,
        }
      : {}),
  };
}

/**
 * Resolves the branch a send carries now that the composer has no branch
 * selector. An explicit choice (draft context, thread metadata, or a pending
 * override) always wins. A first send in worktree mode falls back to the repo
 * default branch (origin/HEAD), then the checked-out branch, once refs have
 * loaded. Local sends and existing worktrees never invent a base branch, and
 * an unresolved worktree base keeps the existing send-time error.
 */
export function resolveComposerBranchForSend(input: {
  effectiveEnvMode: DraftThreadEnvMode;
  explicitBranch: string | null;
  activeWorktreePath: string | null;
  defaultBranchName: string | null;
  currentGitBranch: string | null;
  refsLoadPending: boolean;
}): string | null {
  if (input.explicitBranch) {
    return input.explicitBranch;
  }

  if (input.effectiveEnvMode !== "worktree" || input.activeWorktreePath) {
    return null;
  }

  if (input.refsLoadPending) {
    return null;
  }

  return input.defaultBranchName ?? input.currentGitBranch;
}

export function resolveBackgroundDraftWorkspaceOptions(input: {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  startFromOrigin: boolean;
}): {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  worktreePath: null;
  startFromOrigin: boolean;
} {
  return {
    envMode: input.envMode,
    branch: input.branch,
    worktreePath: null,
    startFromOrigin: input.envMode === "worktree" && input.startFromOrigin,
  };
}
