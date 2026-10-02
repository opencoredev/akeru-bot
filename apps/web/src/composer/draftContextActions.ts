import * as Predicate from "effect/Predicate";
import type { StoreApi } from "zustand";
import { type PreviewAnnotationPayload } from "@akeru/contracts";
import { ensureInlineTerminalContextPlaceholders } from "../lib/terminalContext";
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
} from "./draftTypes";
import { resolveComposerDraftKey, resolveComposerThreadId } from "./draftIdentity";
import {
  shouldRemoveDraft,
  normalizeTerminalContextsForThread,
  normalizeTerminalContextForThread,
  terminalContextDedupKey,
} from "./draftContent";

/**
 * Store actions for the context attached to a composer draft: terminal
 * selections, picked page elements, and preview annotations.
 */
export function createDraftContextActions(
  set: StoreApi<ComposerDraftStoreState>["setState"],
  get: StoreApi<ComposerDraftStoreState>["getState"],
): Pick<
  ComposerDraftStoreState,
  | "setTerminalContexts"
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
> {
  return {
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
        Predicate.isString(threadRef) ? DraftId.make(threadKey) : threadRef,
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
  };
}
