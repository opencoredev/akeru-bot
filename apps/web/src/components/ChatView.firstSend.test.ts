import { MessageId, ProviderInstanceId } from "@akeru/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildFirstSendBootstrap,
  buildFirstSendTurnInput,
  crossWorktreeSendBoundary,
  resolveBackgroundDraftWorkspaceOptions,
  resolveComposerBranchForSend,
  resolveSendEnvMode,
  resolveWorktreeSendGate,
  WORKTREE_BASE_BRANCH_MISSING_ERROR,
  WORKTREE_BRANCHES_LOADING_REASON,
} from "./ChatView.logic";
import { now, projectId, threadId } from "./chatView.test-support";

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("resolveWorktreeSendGate", () => {
  it("is ready when no worktree base branch is needed", () => {
    expect(
      resolveWorktreeSendGate({
        needsWorktreeBaseBranch: false,
        refsLoadPending: true,
        resolvedBranch: null,
      }),
    ).toEqual({ state: "ready" });
  });

  it("is ready once a base branch resolved", () => {
    expect(
      resolveWorktreeSendGate({
        needsWorktreeBaseBranch: true,
        refsLoadPending: false,
        resolvedBranch: "main",
      }),
    ).toEqual({ state: "ready" });
  });

  it("disables send with a loading reason while refs load", () => {
    expect(
      resolveWorktreeSendGate({
        needsWorktreeBaseBranch: true,
        refsLoadPending: true,
        resolvedBranch: null,
      }),
    ).toEqual({ state: "loading", sendDisabledReason: WORKTREE_BRANCHES_LOADING_REASON });
    expect(WORKTREE_BRANCHES_LOADING_REASON).toBe("Loading repository branches");
  });

  it("surfaces the exact actionable error once refs settled without a branch", () => {
    expect(
      resolveWorktreeSendGate({
        needsWorktreeBaseBranch: true,
        refsLoadPending: false,
        resolvedBranch: null,
      }),
    ).toEqual({ state: "missing-base-branch", errorMessage: WORKTREE_BASE_BRANCH_MISSING_ERROR });
    expect(WORKTREE_BASE_BRANCH_MISSING_ERROR).toBe(
      "No base branch found. Create or check out a Git branch, or choose Current checkout in Project settings.",
    );
  });
});

describe("first-send turn payload", () => {
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

  const message = {
    messageId: MessageId.make("message-1"),
    role: "user" as const,
    text: "Ship it",
    attachments: [],
  };

  const baseTurnInput = {
    threadId,
    message,
    modelSelection,
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    createdAt: now,
  };

  const makeCreateThread = (branch: string | null) => ({
    projectId,
    title: "New thread",
    modelSelection,
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    branch,
    worktreePath: null,
    createdAt: now,
  });

  const sendScenario = (input: {
    effectiveEnvMode: "local" | "worktree";
    explicitBranch?: string | null;
    activeWorktreePath?: string | null;
    defaultBranchName?: string | null;
    currentGitBranch?: string | null;
    refsLoadPending?: boolean;
    isLocalDraftThread?: boolean;
    isFirstTurnSend?: boolean;
    startFromOrigin?: boolean;
  }) => {
    const resolvedBranch = resolveComposerBranchForSend({
      effectiveEnvMode: input.effectiveEnvMode,
      explicitBranch: input.explicitBranch ?? null,
      activeWorktreePath: input.activeWorktreePath ?? null,
      defaultBranchName: input.defaultBranchName ?? null,
      currentGitBranch: input.currentGitBranch ?? null,
      refsLoadPending: input.refsLoadPending ?? false,
    });

    const gate = resolveWorktreeSendGate({
      needsWorktreeBaseBranch:
        (input.isFirstTurnSend ?? true) &&
        input.effectiveEnvMode === "worktree" &&
        (input.activeWorktreePath ?? null) === null,
      refsLoadPending: input.refsLoadPending ?? false,
      resolvedBranch,
    });

    const baseBranchForWorktree =
      (input.isFirstTurnSend ?? true) &&
      input.effectiveEnvMode === "worktree" &&
      !(input.activeWorktreePath ?? null)
        ? resolvedBranch
        : null;

    const bootstrap = buildFirstSendBootstrap({
      isLocalDraftThread: input.isLocalDraftThread ?? true,
      baseBranchForWorktree,
      createThread: makeCreateThread(resolvedBranch),
      projectCwd: "/repo",
      worktreeBranch: "t3/tmp-branch",
      startFromOrigin: input.startFromOrigin ?? false,
    });

    const turnInput = buildFirstSendTurnInput({
      ...baseTurnInput,
      ...(bootstrap ? { bootstrap } : {}),
    });

    return { resolvedBranch, gate, turnInput };
  };

  it("builds the complete local draft turn input", () => {
    const { gate, turnInput } = sendScenario({ effectiveEnvMode: "local" });
    expect(gate).toEqual({ state: "ready" });
    expect(turnInput).toEqual({
      ...baseTurnInput,
      bootstrap: { createThread: makeCreateThread(null) },
    });
  });

  it("builds the complete configured-worktree turn input", () => {
    const { resolvedBranch, gate, turnInput } = sendScenario({
      effectiveEnvMode: "worktree",
      defaultBranchName: "origin/main",
      currentGitBranch: "feature/current",
      startFromOrigin: true,
    });

    expect(resolvedBranch).toBe("origin/main");
    expect(gate).toEqual({ state: "ready" });
    expect(turnInput).toEqual({
      ...baseTurnInput,
      bootstrap: {
        createThread: makeCreateThread("origin/main"),
        prepareWorktree: {
          projectCwd: "/repo",
          baseBranch: "origin/main",
          branch: "t3/tmp-branch",
          startFromOrigin: true,
        },
        runSetupScript: true,
      },
    });
  });

  it("puts the explicit branch in the complete turn input", () => {
    const { resolvedBranch, turnInput } = sendScenario({
      effectiveEnvMode: "worktree",
      explicitBranch: "feature/picked",
      defaultBranchName: "origin/main",
    });

    expect(resolvedBranch).toBe("feature/picked");
    expect(turnInput).toEqual({
      ...baseTurnInput,
      bootstrap: {
        createThread: makeCreateThread("feature/picked"),
        prepareWorktree: {
          projectCwd: "/repo",
          baseBranch: "feature/picked",
          branch: "t3/tmp-branch",
        },
        runSetupScript: true,
      },
    });
  });

  it("puts the checked-out branch fallback in the complete turn input", () => {
    const { resolvedBranch, turnInput } = sendScenario({
      effectiveEnvMode: "worktree",
      currentGitBranch: "feature/current",
    });

    expect(resolvedBranch).toBe("feature/current");
    expect(turnInput).toEqual({
      ...baseTurnInput,
      bootstrap: {
        createThread: makeCreateThread("feature/current"),
        prepareWorktree: {
          projectCwd: "/repo",
          baseBranch: "feature/current",
          branch: "t3/tmp-branch",
        },
        runSetupScript: true,
      },
    });
  });

  it("builds the complete existing-thread input without bootstrap", () => {
    const { gate, turnInput } = sendScenario({
      effectiveEnvMode: "local",
      isLocalDraftThread: false,
      isFirstTurnSend: false,
    });

    expect(gate).toEqual({ state: "ready" });
    expect(turnInput).toEqual(baseTurnInput);
  });

  it("builds the complete existing-worktree input without bootstrap or an invented branch", () => {
    const { resolvedBranch, gate, turnInput } = sendScenario({
      effectiveEnvMode: "worktree",
      activeWorktreePath: "/repo/.worktrees/t3-1",
      isLocalDraftThread: false,
      defaultBranchName: "origin/main",
    });

    expect(resolvedBranch).toBeNull();
    expect(gate).toEqual({ state: "ready" });
    expect(turnInput).toEqual(baseTurnInput);
  });

  it("builds the complete background-draft turn input and next-draft workspace options", () => {
    const { resolvedBranch, turnInput } = sendScenario({
      effectiveEnvMode: "worktree",
      defaultBranchName: "origin/main",
      startFromOrigin: true,
    });

    expect(turnInput).toEqual({
      ...baseTurnInput,
      bootstrap: {
        createThread: makeCreateThread("origin/main"),
        prepareWorktree: {
          projectCwd: "/repo",
          baseBranch: "origin/main",
          branch: "t3/tmp-branch",
          startFromOrigin: true,
        },
        runSetupScript: true,
      },
    });
    expect(
      resolveBackgroundDraftWorkspaceOptions({
        envMode: "worktree",
        branch: resolvedBranch,
        startFromOrigin: true,
      }),
    ).toEqual({
      envMode: "worktree",
      branch: "origin/main",
      worktreePath: null,
      startFromOrigin: true,
    });
  });

  const makeBoundaryContinuationSpies = () => {
    const clearPrompt = vi.fn();
    const clearAttachments = vi.fn();
    const clearContexts = vi.fn();
    const appendOptimisticMessage = vi.fn();
    const dispatchTurn = vi.fn();
    const setThreadError = vi.fn();

    const send = vi.fn(() => {
      clearPrompt();
      clearAttachments();
      clearContexts();
      appendOptimisticMessage();
      dispatchTurn();

      return "turn-started";
    });

    return {
      clearPrompt,
      clearAttachments,
      clearContexts,
      appendOptimisticMessage,
      dispatchTurn,
      setThreadError,
      send,
    };
  };

  it("blocks the supplied continuation while worktree refs load", async () => {
    const { resolvedBranch, gate } = sendScenario({
      effectiveEnvMode: "worktree",
      refsLoadPending: true,
      defaultBranchName: null,
      currentGitBranch: null,
    });

    expect(resolvedBranch).toBeNull();
    expect(gate).toEqual({
      state: "loading",
      sendDisabledReason: WORKTREE_BRANCHES_LOADING_REASON,
    });

    const continuation = makeBoundaryContinuationSpies();

    const outcome = await crossWorktreeSendBoundary({
      gate,
      requiresWorktreeCreation: true,
      threadId,
      setThreadError: continuation.setThreadError,
      send: continuation.send,
    });

    expect(outcome).toEqual({ outcome: "blocked-loading" });
    expect(continuation.send).not.toHaveBeenCalled();
    expect(continuation.clearPrompt).not.toHaveBeenCalled();
    expect(continuation.clearAttachments).not.toHaveBeenCalled();
    expect(continuation.clearContexts).not.toHaveBeenCalled();
    expect(continuation.appendOptimisticMessage).not.toHaveBeenCalled();
    expect(continuation.dispatchTurn).not.toHaveBeenCalled();
    expect(continuation.setThreadError).not.toHaveBeenCalled();
  });

  it("sets the missing-branch error without running the supplied continuation", async () => {
    const { gate } = sendScenario({
      effectiveEnvMode: "worktree",
      defaultBranchName: null,
      currentGitBranch: null,
    });

    expect(gate).toEqual({
      state: "missing-base-branch",
      errorMessage:
        "No base branch found. Create or check out a Git branch, or choose Current checkout in Project settings.",
    });

    const continuation = makeBoundaryContinuationSpies();

    const outcome = await crossWorktreeSendBoundary({
      gate,
      requiresWorktreeCreation: true,
      threadId,
      setThreadError: continuation.setThreadError,
      send: continuation.send,
    });

    expect(outcome).toEqual({ outcome: "blocked-missing-base-branch" });
    expect(continuation.setThreadError).toHaveBeenCalledExactlyOnceWith(
      threadId,
      WORKTREE_BASE_BRANCH_MISSING_ERROR,
    );
    expect(continuation.send).not.toHaveBeenCalled();
    expect(continuation.clearPrompt).not.toHaveBeenCalled();
    expect(continuation.clearAttachments).not.toHaveBeenCalled();
    expect(continuation.clearContexts).not.toHaveBeenCalled();
    expect(continuation.appendOptimisticMessage).not.toHaveBeenCalled();
    expect(continuation.dispatchTurn).not.toHaveBeenCalled();
  });

  it("runs the supplied continuation once for a resolved worktree base", async () => {
    const { gate } = sendScenario({
      effectiveEnvMode: "worktree",
      defaultBranchName: "origin/main",
    });

    expect(gate).toEqual({ state: "ready" });

    const continuation = makeBoundaryContinuationSpies();

    const outcome = await crossWorktreeSendBoundary({
      gate,
      requiresWorktreeCreation: true,
      threadId,
      setThreadError: continuation.setThreadError,
      send: continuation.send,
    });

    expect(outcome).toEqual({ outcome: "sent", result: "turn-started" });
    expect(continuation.send).toHaveBeenCalledTimes(1);
    expect(continuation.dispatchTurn).toHaveBeenCalledTimes(1);
    expect(continuation.setThreadError).not.toHaveBeenCalled();
  });
});

describe("buildFirstSendBootstrap", () => {
  const createThread = {
    projectId,
    title: "New thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    createdAt: now,
  };

  const base = {
    isLocalDraftThread: true,
    baseBranchForWorktree: null,
    createThread,
    projectCwd: "/repo",
    worktreeBranch: "t3/tmp-branch",
    startFromOrigin: false,
  };

  it("sends a local-checkout draft with its model and runtime mode and no worktree", () => {
    expect(buildFirstSendBootstrap(base)).toEqual({ createThread });
  });

  it("prepares a worktree only when a base branch resolved", () => {
    expect(buildFirstSendBootstrap({ ...base, baseBranchForWorktree: "main" })).toEqual({
      createThread,
      prepareWorktree: {
        projectCwd: "/repo",
        baseBranch: "main",
        branch: "t3/tmp-branch",
      },
      runSetupScript: true,
    });
    expect(
      buildFirstSendBootstrap({ ...base, baseBranchForWorktree: "main", startFromOrigin: true })
        ?.prepareWorktree?.startFromOrigin,
    ).toBe(true);
  });

  it("carries no bootstrap for a started server thread", () => {
    expect(buildFirstSendBootstrap({ ...base, isLocalDraftThread: false })).toBeUndefined();
  });
});

describe("resolveComposerBranchForSend", () => {
  const worktreeSend = {
    effectiveEnvMode: "worktree" as const,
    explicitBranch: null,
    activeWorktreePath: null,
    defaultBranchName: "origin/main",
    currentGitBranch: "feature/checked-out",
    refsLoadPending: false,
  };

  it("lets an explicit branch win over every fallback", () => {
    expect(
      resolveComposerBranchForSend({ ...worktreeSend, explicitBranch: "feature/picked" }),
    ).toBe("feature/picked");
    expect(
      resolveComposerBranchForSend({
        ...worktreeSend,
        effectiveEnvMode: "local",
        explicitBranch: "feature/picked",
      }),
    ).toBe("feature/picked");
  });

  it("falls back to the repo default branch for a new worktree send", () => {
    expect(resolveComposerBranchForSend(worktreeSend)).toBe("origin/main");
  });

  it("uses the checked-out branch when no default branch is known", () => {
    expect(resolveComposerBranchForSend({ ...worktreeSend, defaultBranchName: null })).toBe(
      "feature/checked-out",
    );
  });

  it("stays unresolved before refs have loaded", () => {
    expect(resolveComposerBranchForSend({ ...worktreeSend, refsLoadPending: true })).toBeNull();
  });

  it("stays unresolved when neither a default nor a checked-out branch exists", () => {
    expect(
      resolveComposerBranchForSend({
        ...worktreeSend,
        defaultBranchName: null,
        currentGitBranch: null,
      }),
    ).toBeNull();
  });

  it("does not invent a worktree base for local sends", () => {
    expect(resolveComposerBranchForSend({ ...worktreeSend, effectiveEnvMode: "local" })).toBeNull();
  });

  it("does not rebase an existing worktree onto the default branch", () => {
    expect(
      resolveComposerBranchForSend({ ...worktreeSend, activeWorktreePath: "/tmp/worktree" }),
    ).toBeNull();
  });
});

describe("resolveBackgroundDraftWorkspaceOptions", () => {
  it("keeps New worktree selected without reusing the launched worktree", () => {
    expect(
      resolveBackgroundDraftWorkspaceOptions({
        envMode: "worktree",
        branch: "main",
        startFromOrigin: true,
      }),
    ).toEqual({
      envMode: "worktree",
      branch: "main",
      worktreePath: null,
      startFromOrigin: true,
    });
  });
});
