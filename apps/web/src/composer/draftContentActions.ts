import type { StoreApi } from "zustand";
import { type PreviewAnnotationPayload } from "@akeru/contracts";
import {
  ensureInlineTerminalContextPlaceholders,
  stripInlineTerminalContextPlaceholders,
} from "../lib/terminalContext";
import {
  type ElementContextDraft,
  elementContextDedupKey,
  newElementContextId,
} from "../lib/elementContext";
import {
  type ComposerDraftStoreState,
  createEmptyThreadDraft,
  type ComposerThreadDraftState,
  DraftId,
  type ComposerImageAttachment,
} from "./draftTypes";
import { resolveComposerDraftKey, resolveComposerThreadId } from "./draftIdentity";
import {
  shouldRemoveDraft,
  normalizeTerminalContextsForThread,
  composerImageDedupKey,
  revokeObjectPreviewUrl,
  normalizeTerminalContextForThread,
  terminalContextDedupKey,
} from "./draftContent";
import { verifyPersistedAttachments } from "./draftPersistence";

export function createDraftContentActions(
  set: StoreApi<ComposerDraftStoreState>["setState"],
  get: StoreApi<ComposerDraftStoreState>["getState"],
): Pick<
  ComposerDraftStoreState,
  | "setPrompt"
  | "setTerminalContexts"
  | "addImage"
  | "addImages"
  | "removeImage"
  | "insertTerminalContext"
  | "addTerminalContext"
  | "addTerminalContexts"
  | "removeTerminalContext"
  | "clearTerminalContexts"
  | "addElementContext"
  | "setElementContexts"
  | "removeElementContext"
  | "clearElementContexts"
  | "addPreviewAnnotation"
  | "setPreviewAnnotations"
  | "removePreviewAnnotation"
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

    setTerminalContexts: (threadRef, contexts) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);

      if (!threadKey || !threadId) {
        return;
      }

      const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();

        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt: ensureInlineTerminalContextPlaceholders(
            existing.prompt,
            normalizedContexts.length,
          ),
          terminalContexts: normalizedContexts,
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

      get().addImages(typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef, [image]);
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

    insertTerminalContext: (threadRef, prompt, context, index) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);

      if (!threadKey || !threadId) {
        return false;
      }

      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const normalizedContext = normalizeTerminalContextForThread(threadId, context);

        if (!normalizedContext) {
          return state;
        }

        const dedupKey = terminalContextDedupKey(normalizedContext);

        if (
          existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
          existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
        ) {
          return state;
        }

        inserted = true;
        const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));

        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
          terminalContexts: [
            ...existing.terminalContexts.slice(0, boundedIndex),
            normalizedContext,
            ...existing.terminalContexts.slice(boundedIndex),
          ],
        };

        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: nextDraft,
          },
        };
      });

      return inserted;
    },

    addTerminalContext: (threadRef, context) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);

      if (!threadKey || !threadId) {
        return;
      }

      get().addTerminalContexts(
        typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef,
        [context],
      );
    },

    addTerminalContexts: (threadRef, contexts) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);

      if (!threadKey || !threadId || contexts.length === 0) {
        return;
      }

      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();

        const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
          ...existing.terminalContexts,
          ...contexts,
        ]).slice(existing.terminalContexts.length);

        if (acceptedContexts.length === 0) {
          return state;
        }

        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              prompt: ensureInlineTerminalContextPlaceholders(
                existing.prompt,
                existing.terminalContexts.length + acceptedContexts.length,
              ),
              terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
            },
          },
        };
      });
    },

    removeTerminalContext: (threadRef, contextId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0 || contextId.length === 0) {
        return;
      }

      set((state) => {
        const current = state.draftsByThreadKey[threadKey];

        if (!current) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: current.terminalContexts.filter((context) => context.id !== contextId),
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

    clearTerminalContexts: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) {
        return;
      }

      set((state) => {
        const current = state.draftsByThreadKey[threadKey];

        if (!current || current.terminalContexts.length === 0) {
          return state;
        }

        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: [],
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

    addElementContext: (threadRef, selection) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);

      if (!threadKey || !threadId) return false;
      let accepted = false;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const dedupKey = elementContextDedupKey(selection);

        if (existing.elementContexts.some((entry) => elementContextDedupKey(entry) === dedupKey)) {
          return state;
        }

        accepted = true;

        const draft: ElementContextDraft = {
          ...selection,
          id: newElementContextId(),
          threadId,
          pickedAt: new Date().toISOString(),
        };

        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              elementContexts: [...existing.elementContexts, draft],
            },
          },
        };
      });

      return accepted;
    },

    setElementContexts: (threadRef, contexts) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);

      if (!threadKey) return;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();

        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          elementContexts: [...contexts],
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

    removeElementContext: (threadRef, contextId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0 || contextId.length === 0) return;
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];

        if (!current) return state;
        const filtered = current.elementContexts.filter((entry) => entry.id !== contextId);

        if (filtered.length === current.elementContexts.length) return state;

        const nextDraft: ComposerThreadDraftState = {
          ...current,
          elementContexts: filtered,
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

    clearElementContexts: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";

      if (threadKey.length === 0) return;
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];

        if (!current || current.elementContexts.length === 0) return state;

        const nextDraft: ComposerThreadDraftState = {
          ...current,
          elementContexts: [],
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

    addPreviewAnnotation: (threadRef, annotation) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);

      if (!threadKey) return;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();

        const nextAnnotations = existing.previewAnnotations.filter(
          (entry) => entry.id !== annotation.id,
        );

        const compactAnnotation: PreviewAnnotationPayload = {
          ...annotation,
          screenshot: annotation.screenshot ? { ...annotation.screenshot, dataUrl: "" } : null,
        };

        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              previewAnnotations: [...nextAnnotations, compactAnnotation],
            },
          },
        };
      });
    },

    setPreviewAnnotations: (threadRef, annotations) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);

      if (!threadKey) return;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();

        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: { ...existing, previewAnnotations: [...annotations] },
          },
        };
      });
    },

    removePreviewAnnotation: (threadRef, annotationId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);

      if (!threadKey || !annotationId) return;
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];

        if (!current) return state;

        const previewAnnotations = current.previewAnnotations.filter(
          (entry) => entry.id !== annotationId,
        );

        if (previewAnnotations.length === current.previewAnnotations.length) return state;

        const nextDraft = {
          ...current,
          previewAnnotations,
          images: current.images.filter((image) => image.id !== annotationId),
          persistedAttachments: current.persistedAttachments.filter(
            (image) => image.id !== annotationId,
          ),
          nonPersistedImageIds: current.nonPersistedImageIds.filter(
            (imageId) => imageId !== annotationId,
          ),
        };

        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };

        if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
        else nextDraftsByThreadKey[threadKey] = nextDraft;

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
