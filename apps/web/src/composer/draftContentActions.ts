import * as Predicate from "effect/Predicate";
import type { StoreApi } from "zustand";
import {
  ensureInlineTerminalContextPlaceholders,
  stripInlineTerminalContextPlaceholders,
} from "../lib/terminalContext";
import {
  type ComposerDraftStoreState,
  createEmptyThreadDraft,
  type ComposerThreadDraftState,
  DraftId,
  type ComposerImageAttachment,
} from "./draftTypes";
import { resolveComposerDraftKey, resolveComposerThreadId } from "./draftIdentity";
import { shouldRemoveDraft, composerImageDedupKey, revokeObjectPreviewUrl } from "./draftContent";
import { verifyPersistedAttachments } from "./draftPersistence";

export function createDraftContentActions(
  set: StoreApi<ComposerDraftStoreState>["setState"],
  get: StoreApi<ComposerDraftStoreState>["getState"],
): Pick<
  ComposerDraftStoreState,
  | "setPrompt"
  | "addImage"
  | "addImages"
  | "removeImage"
  | "clearPersistedAttachments"
  | "syncPersistedAttachments"
  | "clearComposerContent"
  | "clearComposerPromptAndImages"
  | "moveComposerPromptAndImages"
> {
  return {
    setPrompt: (threadRef, prompt) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) {
        return;
      }

      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();

        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },

    addImage: (threadRef, image) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);

      if (!threadKey || !threadId) {
        return;
      }

      get().addImages(Predicate.isString(threadRef) ? DraftId.make(threadKey) : threadRef, [image]);
    },

    addImages: (threadRef, images) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0 || images.length === 0) {
        return;
      }

      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const existingIds = new Set(existing.images.map((image) => image.id));

        const existingDedupKeys = new Set(
          existing.images.map((image) => composerImageDedupKey(image)),
        );

        const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
        const dedupedIncoming: ComposerImageAttachment[] = [];

        for (const image of images) {
          const dedupKey = composerImageDedupKey(image);

          if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
            // Avoid revoking a blob URL that's still referenced by an accepted image.
            if (!acceptedPreviewUrls.has(image.previewUrl)) {
              revokeObjectPreviewUrl(image.previewUrl);
            }

            continue;
          }

          dedupedIncoming.push(image);
          existingIds.add(image.id);
          existingDedupKeys.add(dedupKey);
          acceptedPreviewUrls.add(image.previewUrl);
        }

        if (dedupedIncoming.length === 0) {
          return state;
        }

        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              images: [...existing.images, ...dedupedIncoming],
            },
          },
        };
      });
    },

    removeImage: (threadRef, imageId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) {
        return;
      }

      const existing = get().draftsByThreadKey[threadKey];

      if (!existing) {
        return;
      }

      const removedImage = existing.images.find((image) => image.id === imageId);

      if (removedImage) {
        revokeObjectPreviewUrl(removedImage.previewUrl);
      }

      set((state) => {
        const current = state.draftsByThreadKey[threadKey];

        if (!current) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...current,
          images: current.images.filter((image) => image.id !== imageId),
          nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
          persistedAttachments: current.persistedAttachments.filter(
            (attachment) => attachment.id !== imageId,
          ),
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },

    clearPersistedAttachments: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) {
        return;
      }

      set((state) => {
        const current = state.draftsByThreadKey[threadKey];

        if (!current) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...current,
          persistedAttachments: [],
          nonPersistedImageIds: [],
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },

    syncPersistedAttachments: (threadRef, attachments) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);

      if (!threadKey) {
        return;
      }

      const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];

        if (!current) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...current,
          // Stage attempted attachments so persist middleware can try writing them.
          persistedAttachments: attachments,
          nonPersistedImageIds: current.nonPersistedImageIds.filter(
            (id) => !attachmentIdSet.has(id),
          ),
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
      Promise.resolve().then(() => {
        verifyPersistedAttachments(threadKey, attachments, set);
      });
    },

    clearComposerContent: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) {
        return;
      }

      set((state) => {
        const current = state.draftsByThreadKey[threadKey];

        if (!current) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: "",
          images: [],
          nonPersistedImageIds: [],
          persistedAttachments: [],
          terminalContexts: [],
          elementContexts: [],
          previewAnnotations: [],
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },

    clearComposerPromptAndImages: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) {
        return;
      }

      set((state) => {
        const current = state.draftsByThreadKey[threadKey];

        if (!current) {
          return state;
        }

        for (const image of current.images) {
          revokeObjectPreviewUrl(image.previewUrl);
        }

        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: ensureInlineTerminalContextPlaceholders("", current.terminalContexts.length),
          images: [],
          nonPersistedImageIds: [],
          persistedAttachments: [],
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },

    moveComposerPromptAndImages: (from, to) => {
      const fromKey = resolveComposerDraftKey(get(), from) ?? "";
      const toKey = resolveComposerDraftKey(get(), to) ?? "";

      if (fromKey.length === 0 || toKey.length === 0 || fromKey === toKey) {
        return;
      }

      set((state) => {
        const source = state.draftsByThreadKey[fromKey];

        if (!source) {
          return state;
        }

        const destination = state.draftsByThreadKey[toKey] ?? createEmptyThreadDraft();

        // Inline placeholders reference the source's terminal contexts,
        // which stay behind; re-anchor the moved prompt to whatever
        // contexts the destination already holds.
        const movedPrompt = ensureInlineTerminalContextPlaceholders(
          stripInlineTerminalContextPlaceholders(source.prompt),
          destination.terminalContexts.length,
        );

        const nextDestination: ComposerThreadDraftState = {
          ...destination,
          prompt: movedPrompt,
          images: [...destination.images, ...source.images],
          nonPersistedImageIds: [
            ...destination.nonPersistedImageIds,
            ...source.nonPersistedImageIds,
          ],
          persistedAttachments: [
            ...destination.persistedAttachments,
            ...source.persistedAttachments,
          ],
        };

        // Same clearing shape as clearComposerPromptAndImages, but the
        // preview URLs are NOT revoked: the images moved and their blobs
        // are still referenced from the destination.
        const nextSource: ComposerThreadDraftState = {
          ...source,
          prompt: ensureInlineTerminalContextPlaceholders("", source.terminalContexts.length),
          images: [],
          nonPersistedImageIds: [],
          persistedAttachments: [],
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextSource)) {
          delete nextDraftsByThreadKey[fromKey];
        } else {
          nextDraftsByThreadKey[fromKey] = nextSource;
        }

        if (shouldRemoveDraft(nextDestination)) {
          delete nextDraftsByThreadKey[toKey];
        } else {
          nextDraftsByThreadKey[toKey] = nextDestination;
        }

        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
  };
}
