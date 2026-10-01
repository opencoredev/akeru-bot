import { ThreadId } from "@akeru/contracts";
import { type TerminalContextDraft, normalizeTerminalContextText } from "../lib/terminalContext";
import { type ComposerImageAttachment, type ComposerThreadDraftState } from "./draftTypes";

export function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

export function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

export function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();

  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }

  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));

  return {
    ...context,
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

export function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);

    if (!normalizedContext) {
      continue;
    }

    const dedupKey = terminalContextDedupKey(normalizedContext);

    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }

    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

export function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.elementContexts.length === 0 &&
    draft.previewAnnotations.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

export function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }

  if (!previewUrl.startsWith("blob:")) {
    return;
  }

  URL.revokeObjectURL(previewUrl);
}

export function revokeDraftThreadPreviewUrls(draft: ComposerThreadDraftState | undefined): void {
  if (!draft) {
    return;
  }

  for (const image of draft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
}
