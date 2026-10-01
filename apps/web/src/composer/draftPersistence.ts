import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { StoredComposerMigration } from "./draftMigrationSchemas";
import * as Predicate from "effect/Predicate";
import { EnvironmentId, ModelSelection, ProviderInstanceId, ThreadId } from "@akeru/contracts";
import { scopeProjectRef, scopeThreadRef } from "@akeru/client-runtime/environment";
import { DeepMutable } from "effect/Types";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { createDebouncedStorage, createMemoryStorage } from "../lib/storage";
import { createMigratingStorage } from "../lib/storageKeyMigration";
import {
  type PersistedComposerDraftStoreState,
  EMPTY_PERSISTED_DRAFT_STORE_STATE,
  type PersistedComposerThreadDraftState,
  PersistedComposerDraftStoreStorage,
  type PersistedComposerImageAttachment,
  type PersistedDraftThreadState,
} from "./draftPersistenceSchemas";
import {
  normalizeProviderModelOptions,
  normalizeModelSelection,
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  normalizeProviderInstanceId,
  compactModelSelectionByProvider,
} from "./draftModelSelection";
import {
  normalizePersistedDraftThreads,
  normalizePersistedDraftsByThreadId,
} from "./draftPersistenceNormalization";
import {
  type ComposerDraftStoreState,
  composerDraftHasUserContent,
  type ComposerThreadDraftState,
  type ComposerImageAttachment,
  type DraftThreadState,
} from "./draftTypes";
import { isDraftThreadPromoting, projectDraftKey } from "./draftIdentity";
import { shouldRemoveDraft } from "./draftContent";

export const COMPOSER_DRAFT_STORAGE_KEY = "akeru:composer-drafts:v1";

// Drafts persisted under the `t3code:` prefix before the rebrand.
export const LEGACY_COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";

export const COMPOSER_DRAFT_STORAGE_VERSION = 8;

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

export const composerDebouncedStorage = createDebouncedStorage(
  createMigratingStorage(
    typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
    COMPOSER_DRAFT_STORAGE_KEY,
    LEGACY_COMPOSER_DRAFT_STORAGE_KEY,
  ),
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

const decodeStoredComposerMigration = Schema.decodeUnknownOption(StoredComposerMigration);

export function migratePersistedComposerDraftStoreState(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This storage migration decodes the legacy draft schema before reading persisted fields.
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  const decoded = decodeStoredComposerMigration(persistedState);

  if (Option.isNone(decoded)) {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }

  const candidate = decoded.value;
  const rawDraftMap = candidate.draftsByThreadKey ?? candidate.draftsByThreadId;

  const rawDraftThreadsByThreadId =
    candidate.draftThreadsByThreadKey ?? candidate.draftThreadsByThreadId;

  const rawProjectDraftThreadIdByProjectKey =
    candidate.logicalProjectDraftThreadKeyByLogicalProjectKey ??
    candidate.projectDraftThreadKeyByProjectKey ??
    candidate.projectDraftThreadIdByProjectKey ??
    candidate.projectDraftThreadIdByProjectId;

  // Migrate sticky state from v2 (dual) to v3 (consolidated)
  const stickyModelOptions = normalizeProviderModelOptions(candidate.stickyModelOptions) ?? {};

  const normalizedStickyModelSelection = normalizeModelSelection(candidate.stickyModelSelection, {
    provider: candidate.stickyProvider ?? "codex",
    model: candidate.stickyModel,
    modelOptions: stickyModelOptions,
  });

  const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
    normalizedStickyModelSelection,
    stickyModelOptions,
  );

  const stickyModelSelection = legacySyncModelSelectionOptions(
    normalizedStickyModelSelection,
    nextStickyModelOptions,
  );

  const stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
    stickyModelSelection,
    nextStickyModelOptions,
  );

  const stickyActiveProvider = normalizeProviderInstanceId(candidate.stickyProvider) ?? null;

  const { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey } =
    normalizePersistedDraftThreads(rawDraftThreadsByThreadId, rawProjectDraftThreadIdByProjectKey);

  const draftsByThreadKey = normalizePersistedDraftsByThreadId(
    rawDraftMap,
    draftThreadsByThreadKey,
  );

  return {
    draftsByThreadKey,
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyActiveProvider,
  };
}

export function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  // Draft sessions worth persisting: mapped (a new-thread flow targets
  // them), promoting (mid-send), or holding real user content (they back a
  // sidebar row). Everything else is a zombie — and its composer blob must
  // be dropped WITH it, or model/mode-only entries would persist forever
  // keyed to a session that no longer exists.
  const mappedDraftKeys = new Set(
    Object.values(state.logicalProjectDraftThreadKeyByLogicalProjectKey),
  );

  const keptSessionKeys = new Set(
    Object.entries(state.draftThreadsByThreadKey)
      .filter(
        ([threadKey, draftThread]) =>
          mappedDraftKeys.has(threadKey) ||
          isDraftThreadPromoting(draftThread) ||
          composerDraftHasUserContent(state.draftsByThreadKey[threadKey]),
      )
      .map(([threadKey]) => threadKey),
  );

  const persistedDraftsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState["draftsByThreadKey"]
  > = {};

  for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey)) {
    if (!Predicate.isString(threadKey) || threadKey.length === 0) {
      continue;
    }

    // Composer content keyed to a dropped draft session goes with it.
    // Server-thread keys have no session entry and are unaffected.
    if (state.draftThreadsByThreadKey[threadKey] !== undefined && !keptSessionKeys.has(threadKey)) {
      continue;
    }

    const hasModelData =
      Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;

    if (
      draft.prompt.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.terminalContexts.length === 0 &&
      draft.elementContexts.length === 0 &&
      draft.previewAnnotations.length === 0 &&
      !hasModelData &&
      draft.runtimeMode === null &&
      draft.interactionMode === null
    ) {
      continue;
    }

    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      attachments: draft.persistedAttachments,
      ...(draft.terminalContexts.length > 0
        ? {
            terminalContexts: draft.terminalContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
            })),
          }
        : {}),
      ...(draft.elementContexts.length > 0
        ? {
            elementContexts: draft.elementContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              pickedAt: context.pickedAt,
              pageUrl: context.pageUrl,
              pageTitle: context.pageTitle,
              tagName: context.tagName,
              selector: context.selector,
              htmlPreview: context.htmlPreview,
              componentName: context.componentName,
              source: context.source,
              styles: context.styles,
            })),
          }
        : {}),
      ...(draft.previewAnnotations.length > 0
        ? {
            previewAnnotations: draft.previewAnnotations.map((annotation) => ({
              ...annotation,
              elements: annotation.elements.map((target) => ({
                ...target,
                element: {
                  ...target.element,
                  stack: target.element.stack.map((frame) => ({ ...frame })),
                },
              })),
              regions: annotation.regions.map((region) => ({ ...region })),
              strokes: annotation.strokes.map((stroke) => ({
                ...stroke,
                points: stroke.points.map((point) => ({ ...point })),
              })),
              styleChanges: annotation.styleChanges.map((change) => ({ ...change })),
            })),
          }
        : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(
              draft.modelSelectionByProvider,
            ),
            activeProvider: draft.activeProvider,
          }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
    };

    persistedDraftsByThreadKey[threadKey] = persistedDraft;
  }

  const persistedDraftThreadsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState["draftThreadsByThreadKey"]
  > = {};

  for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
    if (!keptSessionKeys.has(threadKey)) {
      continue;
    }

    persistedDraftThreadsByThreadKey[threadKey] = draftThread;
  }

  return {
    draftsByThreadKey: persistedDraftsByThreadKey,
    draftThreadsByThreadKey: persistedDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(
      state.stickyModelSelectionByProvider,
    ),
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

export function normalizeCurrentPersistedComposerDraftStoreState(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This storage migration decodes the legacy draft schema before reading persisted fields.
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  const decoded = decodeStoredComposerMigration(persistedState);

  if (Option.isNone(decoded)) {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }

  const normalizedPersistedState = decoded.value;

  const { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey } =
    normalizePersistedDraftThreads(
      normalizedPersistedState.draftThreadsByThreadKey ??
        normalizedPersistedState.draftThreadsByThreadId,
      normalizedPersistedState.logicalProjectDraftThreadKeyByLogicalProjectKey ??
        normalizedPersistedState.projectDraftThreadKeyByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectId,
    );

  // Handle both v3 (modelSelectionByProvider) and v2/legacy formats
  let stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
  let stickyActiveProvider: ProviderInstanceId | null = null;

  if (
    normalizedPersistedState.stickyModelSelectionByProvider &&
    (normalizedPersistedState.stickyModelSelectionByProvider === null ||
      Predicate.isObjectOrArray(normalizedPersistedState.stickyModelSelectionByProvider))
  ) {
    stickyModelSelectionByProvider = normalizedPersistedState.stickyModelSelectionByProvider;
    stickyActiveProvider = normalizeProviderInstanceId(
      normalizedPersistedState.stickyActiveProvider,
    );
  } else {
    // Legacy migration path
    const stickyModelOptions =
      normalizeProviderModelOptions(normalizedPersistedState.stickyModelOptions) ?? {};

    const normalizedStickyModelSelection = normalizeModelSelection(
      normalizedPersistedState.stickyModelSelection,
      {
        provider: normalizedPersistedState.stickyProvider,
        model: normalizedPersistedState.stickyModel,
        modelOptions: stickyModelOptions,
      },
    );

    const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
      normalizedStickyModelSelection,
      stickyModelOptions,
    );

    const stickyModelSelection = legacySyncModelSelectionOptions(
      normalizedStickyModelSelection,
      nextStickyModelOptions,
    );

    stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
      stickyModelSelection,
      nextStickyModelOptions,
    );
    stickyActiveProvider = normalizeProviderInstanceId(normalizedPersistedState.stickyProvider);
  }

  return {
    draftsByThreadKey: normalizePersistedDraftsByThreadId(
      normalizedPersistedState.draftsByThreadKey ?? normalizedPersistedState.draftsByThreadId,
      draftThreadsByThreadKey,
    ),
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyActiveProvider,
  };
}

function readPersistedAttachmentIdsFromStorage(threadKey: string): string[] {
  if (threadKey.length === 0) {
    return [];
  }

  try {
    const persisted = getLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      PersistedComposerDraftStoreStorage,
    );

    if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) {
      return [];
    }

    return (persisted.state.draftsByThreadKey[threadKey]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

export function verifyPersistedAttachments(
  threadKey: string,
  attachments: PersistedComposerImageAttachment[],
  set: (
    partial:
      | ComposerDraftStoreState
      | Partial<ComposerDraftStoreState>
      | ((
          state: ComposerDraftStoreState,
        ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
    replace?: false,
  ) => void,
): void {
  let persistedIdSet = new Set<string>();

  try {
    composerDebouncedStorage.flush();
    persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadKey));
  } catch {
    persistedIdSet = new Set();
  }

  set((state) => {
    const current = state.draftsByThreadKey[threadKey];

    if (!current) {
      return state;
    }

    const imageIdSet = new Set(current.images.map((image) => image.id));

    const persistedAttachments = attachments.filter(
      (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
    );

    const nonPersistedImageIds: string[] = [];

    for (const image of current.images) {
      if (!persistedIdSet.has(image.id)) {
        nonPersistedImageIds.push(image.id);
      }
    }

    const nextDraft: ComposerThreadDraftState = {
      ...current,
      persistedAttachments,
      nonPersistedImageIds,
    };

    const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

    if (shouldRemoveDraft(nextDraft)) {
      delete nextDraftsByThreadKey[threadKey];
    } else {
      nextDraftsByThreadKey[threadKey] = nextDraft;
    }

    return { draftsByThreadKey: nextDraftsByThreadKey };
  });
}

function hydratePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);

  if (payload.length === 0) {
    return null;
  }

  try {
    const isBase64 = header.includes(";base64");

    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);

      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;

      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }

    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

export function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydratePersistedComposerImageAttachment(attachment);

    if (!file) return [];

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
      } satisfies ComposerImageAttachment,
    ];
  });
}

export function toHydratedThreadDraft(
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  // The persisted draft is already in v3 shape (migration handles older formats)
  const modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> =
    persistedDraft.modelSelectionByProvider ?? {};

  const activeProvider = normalizeProviderInstanceId(persistedDraft.activeProvider) ?? null;

  return {
    prompt: persistedDraft.prompt,
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: "",
      })) ?? [],
    elementContexts:
      persistedDraft.elementContexts?.map((context) => ({
        ...context,
      })) ?? [],
    previewAnnotations:
      persistedDraft.previewAnnotations?.map((annotation) => ({ ...annotation })) ?? [],
    modelSelectionByProvider,
    activeProvider,
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
  };
}

export function toHydratedDraftThreadState(
  persistedDraftThread: PersistedDraftThreadState,
): DraftThreadState {
  return {
    threadId: persistedDraftThread.threadId,
    environmentId: EnvironmentId.make(persistedDraftThread.environmentId),
    projectId: persistedDraftThread.projectId,
    logicalProjectKey:
      persistedDraftThread.logicalProjectKey ??
      projectDraftKey(
        scopeProjectRef(
          EnvironmentId.make(persistedDraftThread.environmentId),
          persistedDraftThread.projectId,
        ),
      ),
    createdAt: persistedDraftThread.createdAt,
    runtimeMode: persistedDraftThread.runtimeMode,
    interactionMode: persistedDraftThread.interactionMode,
    branch: persistedDraftThread.branch,
    worktreePath: persistedDraftThread.worktreePath,
    envMode: persistedDraftThread.envMode,
    startFromOrigin: persistedDraftThread.startFromOrigin,
    promotedTo: persistedDraftThread.promotedTo
      ? scopeThreadRef(
          EnvironmentId.make(persistedDraftThread.promotedTo.environmentId),
          ThreadId.make(persistedDraftThread.promotedTo.threadId),
        )
      : null,
  };
}
