import {
  type EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  type ScopedThreadRef,
  ThreadId,
} from "@akeru/contracts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedThreadKey,
} from "@akeru/client-runtime/environment";
import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { migrateLocalStorageKey } from "./lib/storageKeyMigration";
import { UnifiedSettings } from "@akeru/contracts/settings";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  LEGACY_COMPOSER_DRAFT_STORAGE_KEY,
  composerDebouncedStorage,
  COMPOSER_DRAFT_STORAGE_VERSION,
  migratePersistedComposerDraftStoreState,
  partializeComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
  toHydratedThreadDraft,
  toHydratedDraftThreadState,
} from "./composer/draftPersistence";
import {
  EMPTY_IMAGES,
  EMPTY_IDS,
  EMPTY_PERSISTED_ATTACHMENTS,
  EMPTY_ELEMENT_CONTEXTS,
  EMPTY_PREVIEW_ANNOTATIONS,
  type ComposerDraftStoreState,
  type DraftThreadState,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  EMPTY_THREAD_DRAFT,
  type ComposerDraftModelState,
  EMPTY_COMPOSER_DRAFT_MODEL_STATE,
  DraftId,
  type EffectiveComposerModelState,
} from "./composer/draftTypes";
import { createDraftIdentityActions } from "./composer/draftIdentityActions";
import { createDraftModelActions } from "./composer/draftModelActions";
import { createDraftContentActions } from "./composer/draftContentActions";
import { revokeDraftThreadPreviewUrls } from "./composer/draftContent";
import { getComposerDraftState } from "./composer/draftIdentity";
import { deriveEffectiveComposerModelState } from "./composer/draftModelSelection";

// Copy the pre-rebrand drafts payload forward so reads that bypass the
// wrapped storage (like the attachment verifier) still find it.
migrateLocalStorageKey(COMPOSER_DRAFT_STORAGE_KEY, LEGACY_COMPOSER_DRAFT_STORAGE_KEY);

// Flush pending composer draft writes before page unload to prevent data loss.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

Object.freeze(EMPTY_IMAGES);

Object.freeze(EMPTY_IDS);

Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);

Object.freeze(EMPTY_ELEMENT_CONTEXTS);

Object.freeze(EMPTY_PREVIEW_ANNOTATIONS);

const composerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (setBase, get) => {
      const set = setBase;

      return {
        draftsByThreadKey: {},
        draftThreadsByThreadKey: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
        backgroundSubmissionThreadKeys: {},
        stickyModelSelectionByProvider: {},
        stickyActiveProvider: null,
        ...createDraftIdentityActions(set, get),
        ...createDraftModelActions(set, get),
        ...createDraftContentActions(set, get),
      };
    },
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: createJSONStorage(() => composerDebouncedStorage),
      migrate: migratePersistedComposerDraftStoreState,
      partialize: partializeComposerDraftStoreState,
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);

        const draftsByThreadKey = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadKey).map(([threadKey, draft]) => [
            threadKey,
            toHydratedThreadDraft(draft),
          ]),
        );

        const draftThreadsByThreadKey = Object.fromEntries(
          Object.entries(normalizedPersisted.draftThreadsByThreadKey).map(
            ([threadKey, draftThread]) => [threadKey, toHydratedDraftThreadState(draftThread)],
          ),
        ) as Record<string, DraftThreadState>;

        return {
          ...currentState,
          draftsByThreadKey,
          draftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey:
            normalizedPersisted.logicalProjectDraftThreadKeyByLogicalProjectKey,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

export const useComposerDraftStore = composerDraftStore;

export function beginBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => {
    if (state.backgroundSubmissionThreadKeys[threadKey]) {
      return state;
    }

    return {
      backgroundSubmissionThreadKeys: {
        ...state.backgroundSubmissionThreadKeys,
        [threadKey]: true,
      },
    };
  });
}

export function clearBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => {
    if (!state.backgroundSubmissionThreadKeys[threadKey]) {
      return state;
    }

    const backgroundSubmissionThreadKeys = { ...state.backgroundSubmissionThreadKeys };
    delete backgroundSubmissionThreadKeys[threadKey];

    return { backgroundSubmissionThreadKeys };
  });
}

export function useBackgroundDraftSubmissionPending(threadRef: ScopedThreadRef | null): boolean {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;

  return useComposerDraftStore(
    (state) => threadKey !== null && state.backgroundSubmissionThreadKeys[threadKey] === true,
  );
}

export function clearComposerDraftsEnvironment(environmentId: EnvironmentId): void {
  useComposerDraftStore.setState((state) => {
    const removedThreadKeys = new Set<string>();

    for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
      if (draftThread.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }

    for (const threadKey of Object.keys(state.draftsByThreadKey)) {
      if (parseScopedThreadKey(threadKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }

    for (const [logicalProjectKey, threadKey] of Object.entries(
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    )) {
      if (parseScopedProjectKey(logicalProjectKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }

    const nextLogicalMappings = Object.fromEntries(
      Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
        ([logicalProjectKey, threadKey]) =>
          parseScopedProjectKey(logicalProjectKey)?.environmentId !== environmentId &&
          !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, string>;

    const nextDraftThreads = Object.fromEntries(
      Object.entries(state.draftThreadsByThreadKey).filter(
        ([threadKey, draftThread]) =>
          draftThread.environmentId !== environmentId && !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, DraftThreadState>;

    const nextDrafts = Object.fromEntries(
      Object.entries(state.draftsByThreadKey).filter(([threadKey, draft]) => {
        if (!removedThreadKeys.has(threadKey)) {
          return true;
        }

        revokeDraftThreadPreviewUrls(draft);

        return false;
      }),
    ) as Record<string, ComposerThreadDraftState>;

    const nextBackgroundSubmissionThreadKeys = Object.fromEntries(
      Object.entries(state.backgroundSubmissionThreadKeys).filter(
        ([threadKey]) => parseScopedThreadKey(threadKey)?.environmentId !== environmentId,
      ),
    ) as Record<string, true>;

    return {
      draftsByThreadKey: nextDrafts,
      draftThreadsByThreadKey: nextDraftThreads,
      logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
      backgroundSubmissionThreadKeys: nextBackgroundSubmissionThreadKeys,
    };
  });
  composerDebouncedStorage.flush();
}

export function useComposerThreadDraft(threadRef: ComposerThreadTarget): ComposerThreadDraftState {
  return useComposerDraftStore((state) => {
    return getComposerDraftState(state, threadRef) ?? EMPTY_THREAD_DRAFT;
  });
}

export function useComposerDraftModelState(
  threadRef: ComposerThreadTarget,
): ComposerDraftModelState {
  return useComposerDraftStore(
    useShallow((state) => {
      const draft = getComposerDraftState(state, threadRef);

      return draft
        ? {
            activeProvider: draft.activeProvider,
            modelSelectionByProvider: draft.modelSelectionByProvider,
          }
        : EMPTY_COMPOSER_DRAFT_MODEL_STATE;
    }),
  );
}

export function useEffectiveComposerModelState(input: {
  threadRef?: ComposerThreadTarget;
  draftId?: DraftId;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  /**
   * When supplied, the draft's saved selection for this instance takes
   * precedence over the driver-kind bucket — so a custom `codex_personal`
   * instance reads its own model, not the default Codex's.
   */
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const draft = useComposerDraftModelState(input.threadRef ?? input.draftId ?? DraftId.make(""));

  return useMemo(
    () =>
      deriveEffectiveComposerModelState({
        draft,
        providers: input.providers,
        selectedProvider: input.selectedProvider,
        selectedInstanceId: input.selectedInstanceId,
        threadModelSelection: input.threadModelSelection,
        projectModelSelection: input.projectModelSelection,
        settings: input.settings,
      }),
    [
      draft,
      input.providers,
      input.settings,
      input.projectModelSelection,
      input.selectedInstanceId,
      input.selectedProvider,
      input.threadModelSelection,
    ],
  );
}

/**
 * Mark a draft thread as promoting once the server has materialized the same thread id.
 *
 * Use the single-thread helper for live `thread.created` events and the
 * iterable helper for bootstrap/recovery paths that discover multiple server
 * threads at once.
 */
export function markPromotedDraftThread(threadId: ThreadId): void {
  const store = useComposerDraftStore.getState();
  const draftThreadTargets: ComposerThreadTarget[] = [];

  for (const [draftId, draftThread] of Object.entries(store.draftThreadsByThreadKey)) {
    if (draftThread.threadId === threadId) {
      draftThreadTargets.push(DraftId.make(draftId));
    }
  }

  if (draftThreadTargets.length === 0) {
    return;
  }

  for (const draftThreadTarget of draftThreadTargets) {
    store.markDraftThreadPromoting(draftThreadTarget);
  }
}

export function markPromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();

  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    if (
      draftThread.environmentId === threadRef.environmentId &&
      draftThread.threadId === threadRef.threadId
    ) {
      draftStore.markDraftThreadPromoting(DraftId.make(draftId), threadRef);
    }
  }
}

export function markPromotedDraftThreads(serverThreadIds: Iterable<ThreadId>): void {
  for (const threadId of serverThreadIds) {
    markPromotedDraftThread(threadId);
  }
}

export function markPromotedDraftThreadsByRef(serverThreadRefs: Iterable<ScopedThreadRef>): void {
  for (const threadRef of serverThreadRefs) {
    markPromotedDraftThreadByRef(threadRef);
  }
}

export function finalizePromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();

  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    const promotedRef = draftThread.promotedTo;

    const matches = promotedRef
      ? promotedRef.environmentId === threadRef.environmentId &&
        promotedRef.threadId === threadRef.threadId
      : draftThread.environmentId === threadRef.environmentId &&
        draftThread.threadId === threadRef.threadId;

    if (matches) {
      const target = DraftId.make(draftId);
      draftStore.markDraftThreadPromoting(target, threadRef);
      draftStore.finalizePromotedDraftThread(target);
    }
  }

  clearBackgroundDraftSubmissionByRef(threadRef);
}

export function finalizePromotedDraftThreadsByRef(
  serverThreadRefs: Iterable<ScopedThreadRef>,
): void {
  for (const threadRef of serverThreadRefs) {
    finalizePromotedDraftThreadByRef(threadRef);
  }
}

export {
  type DraftThreadEnvMode,
  DraftId,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  composerDraftHasUserContent,
  type DraftSessionState,
  type DraftThreadState,
  type EffectiveComposerModelState,
  createEmptyThreadDraft,
} from "./composer/draftTypes";

export { deriveEffectiveComposerModelState } from "./composer/draftModelSelection";

export { PersistedComposerImageAttachment } from "./composer/draftPersistenceSchemas";

export {
  COMPOSER_DRAFT_STORAGE_KEY,
  hydrateImagesFromPersisted,
} from "./composer/draftPersistence";
