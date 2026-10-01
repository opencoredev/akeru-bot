import type { StoreApi } from "zustand";
import { ThreadId } from "@akeru/contracts";
import { scopedThreadKey, scopeThreadRef } from "@akeru/client-runtime/environment";
import {
  type ComposerDraftStoreState,
  DraftId,
  type DraftThreadState,
  composerDraftHasUserContent,
} from "./draftTypes";
import {
  getComposerDraftState,
  logicalProjectDraftKey,
  isDraftThreadPromoting,
  toProjectDraftSession,
  createDraftThreadState,
  draftThreadsEqual,
  isComposerThreadKeyInUse,
  projectDraftKey,
  resolveComposerDraftKey,
  scopedThreadRefsEqual,
  removeDraftThreadReferences,
} from "./draftIdentity";

export function createDraftIdentityActions(
  set: StoreApi<ComposerDraftStoreState>["setState"],
  get: StoreApi<ComposerDraftStoreState>["getState"],
): Pick<
  ComposerDraftStoreState,
  | "getComposerDraft"
  | "getDraftThreadByLogicalProjectKey"
  | "getDraftSessionByLogicalProjectKey"
  | "getDraftThreadByProjectRef"
  | "getDraftSessionByProjectRef"
  | "getDraftSession"
  | "getDraftSessionByRef"
  | "getDraftThread"
  | "getDraftThreadByRef"
  | "listDraftThreadKeys"
  | "hasDraftThreadsInEnvironment"
  | "setLogicalProjectDraftThreadId"
  | "setProjectDraftThreadId"
  | "setDraftThreadContext"
  | "clearProjectDraftThreadId"
  | "clearProjectDraftThreadById"
  | "markDraftThreadPromoting"
  | "finalizePromotedDraftThread"
  | "clearDraftThread"
> {
  return {
    getComposerDraft: (target) => getComposerDraftState(get(), target),

    getDraftThreadByLogicalProjectKey: (logicalProjectKey) => {
      return get().getDraftSessionByLogicalProjectKey(logicalProjectKey);
    },

    getDraftSessionByLogicalProjectKey: (logicalProjectKey) => {
      const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
      if (normalizedLogicalProjectKey.length === 0) {
        return null;
      }
      const draftId =
        get().logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
      if (!draftId) {
        return null;
      }
      const draftThread = get().draftThreadsByThreadKey[draftId];
      if (!draftThread || isDraftThreadPromoting(draftThread)) {
        return null;
      }
      return toProjectDraftSession(DraftId.make(draftId), draftThread);
    },

    getDraftThreadByProjectRef: (projectRef) => {
      return get().getDraftSessionByProjectRef(projectRef);
    },

    getDraftSessionByProjectRef: (projectRef) => {
      const state = get();
      // Mapped drafts win: a project can also own older unmapped drafts
      // (invested ones left behind by a remap), but "the" draft for a
      // project is the one new-thread flows currently target.
      for (const draftId of Object.values(state.logicalProjectDraftThreadKeyByLogicalProjectKey)) {
        const draftThread = state.draftThreadsByThreadKey[draftId];
        if (!draftThread || isDraftThreadPromoting(draftThread)) {
          continue;
        }
        if (
          draftThread.projectId === projectRef.projectId &&
          draftThread.environmentId === projectRef.environmentId
        ) {
          return toProjectDraftSession(DraftId.make(draftId), draftThread);
        }
      }
      for (const [draftId, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
        if (isDraftThreadPromoting(draftThread)) {
          continue;
        }
        if (
          draftThread.projectId === projectRef.projectId &&
          draftThread.environmentId === projectRef.environmentId
        ) {
          return toProjectDraftSession(DraftId.make(draftId), draftThread);
        }
      }
      return null;
    },

    getDraftSession: (draftId) => get().draftThreadsByThreadKey[draftId] ?? null,

    getDraftSessionByRef: (threadRef) => {
      for (const draftSession of Object.values(get().draftThreadsByThreadKey)) {
        if (
          draftSession.environmentId === threadRef.environmentId &&
          draftSession.threadId === threadRef.threadId
        ) {
          return draftSession;
        }
      }
      return null;
    },

    getDraftThread: (threadRef) => {
      if (typeof threadRef === "string") {
        return get().getDraftSession(DraftId.make(threadRef));
      }
      return get().getDraftSessionByRef(threadRef);
    },

    getDraftThreadByRef: (threadRef) => {
      return get().getDraftSessionByRef(threadRef);
    },

    listDraftThreadKeys: () =>
      Object.values(get().draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),

    hasDraftThreadsInEnvironment: (environmentId) =>
      Object.values(get().draftThreadsByThreadKey).some(
        (draftThread) => draftThread.environmentId === environmentId,
      ),

    setLogicalProjectDraftThreadId: (logicalProjectKey, projectRef, draftId, options) => {
      const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
      if (normalizedLogicalProjectKey.length === 0 || draftId.length === 0) {
        return;
      }
      set((state) => {
        const existingThread = state.draftThreadsByThreadKey[draftId];
        const previousThreadKeyForLogicalProject =
          state.logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
        const nextDraftThread = createDraftThreadState(
          projectRef,
          options?.threadId ?? existingThread?.threadId ?? ThreadId.make(draftId),
          normalizedLogicalProjectKey,
          existingThread,
          options,
        );
        const hasSameLogicalMapping = previousThreadKeyForLogicalProject === draftId;
        if (hasSameLogicalMapping && draftThreadsEqual(existingThread, nextDraftThread)) {
          return state;
        }
        const nextLogicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {
          ...state.logicalProjectDraftThreadKeyByLogicalProjectKey,
          [normalizedLogicalProjectKey]: draftId,
        };
        const nextDraftThreadsByThreadKey: Record<string, DraftThreadState> = {
          ...state.draftThreadsByThreadKey,
          [draftId]: nextDraftThread,
        };
        let nextDraftsByThreadKey = state.draftsByThreadKey;
        const previousDraftThread =
          previousThreadKeyForLogicalProject === undefined
            ? undefined
            : nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
        // A remap only garbage-collects the previous draft when the user
        // never invested content in it. A draft with typed text or
        // attachments stays alive unmapped — the sidebar draft rows list
        // every such session, so "new thread" can mint a fresh draft
        // without destroying the one the user walked away from.
        if (
          previousThreadKeyForLogicalProject &&
          previousThreadKeyForLogicalProject !== draftId &&
          !isComposerThreadKeyInUse(
            nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
            previousThreadKeyForLogicalProject,
          ) &&
          !isDraftThreadPromoting(previousDraftThread) &&
          !composerDraftHasUserContent(state.draftsByThreadKey[previousThreadKeyForLogicalProject])
        ) {
          delete nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
          if (state.draftsByThreadKey[previousThreadKeyForLogicalProject] !== undefined) {
            nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            delete nextDraftsByThreadKey[previousThreadKeyForLogicalProject];
          }
        }
        return {
          draftsByThreadKey: nextDraftsByThreadKey,
          draftThreadsByThreadKey: nextDraftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey:
            nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
        };
      });
    },

    setProjectDraftThreadId: (projectRef, draftId, options) => {
      get().setLogicalProjectDraftThreadId(
        projectDraftKey(projectRef),
        projectRef,
        draftId,
        options,
      );
    },

    setDraftThreadContext: (threadRef, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadKey[threadKey];
        if (!existing) {
          return state;
        }
        const nextProjectRef = options.projectRef ?? {
          environmentId: existing.environmentId,
          projectId: existing.projectId,
        };
        if (nextProjectRef.projectId.length === 0 || nextProjectRef.environmentId.length === 0) {
          return state;
        }
        // Mirrors createDraftThreadState: a project/environment change
        // drops machine-specific context (branch, worktree path) but
        // keeps the user's env mode and start-from-origin intent.
        const projectChanged =
          nextProjectRef.environmentId !== existing.environmentId ||
          nextProjectRef.projectId !== existing.projectId;
        const nextWorktreePath =
          options.worktreePath === undefined
            ? projectChanged
              ? null
              : existing.worktreePath
            : (options.worktreePath ?? null);
        const nextBranch =
          options.branch === undefined
            ? projectChanged
              ? null
              : existing.branch
            : (options.branch ?? null);
        const nextStartFromOrigin =
          options.startFromOrigin === undefined
            ? existing.startFromOrigin
            : options.startFromOrigin;
        const nextDraftThread: DraftThreadState = {
          threadId: existing.threadId,
          environmentId: nextProjectRef.environmentId,
          projectId: nextProjectRef.projectId,
          logicalProjectKey: existing.logicalProjectKey,
          createdAt:
            options.createdAt === undefined
              ? existing.createdAt
              : options.createdAt || existing.createdAt,
          runtimeMode: options.runtimeMode ?? existing.runtimeMode,
          interactionMode: options.interactionMode ?? existing.interactionMode,
          branch: nextBranch,
          worktreePath: nextWorktreePath,
          envMode:
            options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
          startFromOrigin: nextStartFromOrigin,
          promotedTo: existing.promotedTo ?? null,
        };
        const isUnchanged =
          nextDraftThread.environmentId === existing.environmentId &&
          nextDraftThread.projectId === existing.projectId &&
          nextDraftThread.logicalProjectKey === existing.logicalProjectKey &&
          nextDraftThread.createdAt === existing.createdAt &&
          nextDraftThread.runtimeMode === existing.runtimeMode &&
          nextDraftThread.interactionMode === existing.interactionMode &&
          nextDraftThread.branch === existing.branch &&
          nextDraftThread.worktreePath === existing.worktreePath &&
          nextDraftThread.envMode === existing.envMode &&
          nextDraftThread.startFromOrigin === existing.startFromOrigin &&
          scopedThreadRefsEqual(nextDraftThread.promotedTo, existing.promotedTo);
        if (isUnchanged) {
          return state;
        }
        return {
          draftThreadsByThreadKey: {
            ...state.draftThreadsByThreadKey,
            [threadKey]: nextDraftThread,
          },
        };
      });
    },

    clearProjectDraftThreadId: (projectRef) => {
      set((state) => {
        // A project can own several sessions (invested drafts survive
        // remaps unmapped), so project removal must sweep them all — a
        // leftover would render a sidebar row for a project that no
        // longer exists.
        const matchingThreadKeys = Object.entries(state.draftThreadsByThreadKey)
          .filter(
            ([, draftThread]) =>
              draftThread.projectId === projectRef.projectId &&
              draftThread.environmentId === projectRef.environmentId,
          )
          .map(([threadKey]) => threadKey);
        if (matchingThreadKeys.length === 0) {
          return state;
        }
        let nextState = {
          draftsByThreadKey: state.draftsByThreadKey,
          draftThreadsByThreadKey: state.draftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey:
            state.logicalProjectDraftThreadKeyByLogicalProjectKey,
        };
        for (const threadKey of matchingThreadKeys) {
          nextState = removeDraftThreadReferences(nextState, threadKey);
        }
        return nextState;
      });
    },

    clearProjectDraftThreadById: (projectRef, threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const draftThread = state.draftThreadsByThreadKey[threadKey];
        if (
          !draftThread ||
          draftThread.projectId !== projectRef.projectId ||
          draftThread.environmentId !== projectRef.environmentId
        ) {
          return state;
        }
        return removeDraftThreadReferences(state, threadKey);
      });
    },

    markDraftThreadPromoting: (threadRef, promotedTo) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadKey[threadKey];
        if (!existing) {
          return state;
        }
        const nextPromotedTo =
          promotedTo ?? scopeThreadRef(existing.environmentId, existing.threadId);
        if (scopedThreadRefsEqual(existing.promotedTo, nextPromotedTo)) {
          return state;
        }
        return {
          draftThreadsByThreadKey: {
            ...state.draftThreadsByThreadKey,
            [threadKey]: {
              ...existing,
              promotedTo: nextPromotedTo,
            },
          },
        };
      });
    },

    finalizePromotedDraftThread: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadKey[threadKey];
        if (!isDraftThreadPromoting(existing)) {
          return state;
        }
        return removeDraftThreadReferences(state, threadKey);
      });
    },

    clearDraftThread: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const hasDraftThread = state.draftThreadsByThreadKey[threadKey] !== undefined;
        const hasLogicalProjectMapping = Object.values(
          state.logicalProjectDraftThreadKeyByLogicalProjectKey,
        ).includes(threadKey);
        const hasComposerDraft = state.draftsByThreadKey[threadKey] !== undefined;
        if (!hasDraftThread && !hasLogicalProjectMapping && !hasComposerDraft) {
          return state;
        }
        return removeDraftThreadReferences(state, threadKey);
      });
    },
  };
}
