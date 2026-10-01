import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@akeru/contracts";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import {
  hydrateImagesFromPersisted,
  type PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import { useI18n } from "../../i18n";
import { compressImageForStash } from "../../lib/imageCompression";
import { randomUUID } from "../../lib/utils";
import {
  MAX_STASH_ENTRIES,
  partitionStashAttachments,
  usePromptStashStore,
  type PromptStashEntry,
} from "../../promptStashStore";
import { toastManager } from "../ui/toast";
import { clearBotDraft, readBotDraft, writeBotDraft } from "./botDraftStore";
import {
  buildBotPromptAttachmentPreview,
  createBotPromptAttachments,
  releaseBotPromptAttachments,
  type BotPromptAttachment,
} from "./BotPromptAttachments";
import {
  canSubmitBotPrompt,
  isBotPromptSubmissionCurrent,
  type MentionBot,
  resolveBotMention,
  restoreBotStashPrompt,
} from "./botPromptComposer.logic";

/**
 * Owns a bot composer's draft text, attachments, and prompt stash. Every change bumps a
 * revision so a failed send only restores the draft when nothing changed meanwhile, and
 * each attachment preview URL is released exactly once, whichever path lets it go.
 */
export function useBotComposerDraft(input: {
  readonly draftKey: string | undefined;
  readonly promptInputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { draftKey, promptInputRef } = input;
  const { t, plural } = useI18n();
  const [draft, setDraft] = useState(() => (draftKey ? readBotDraft(draftKey) : ""));
  // Bumped whenever the draft is sent, stashed, or swapped, so a late transcript is dropped.
  const [dictationGeneration, setDictationGeneration] = useState(0);
  const [attachments, setAttachments] = useState<BotPromptAttachment[]>([]);

  const [failedAttachmentIds, setFailedAttachmentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const [expandedAttachmentId, setExpandedAttachmentId] = useState<string | null>(null);
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  const [stashPulse, setStashPulse] = useState({ key: 0, active: false });
  const attachmentsRef = useRef<BotPromptAttachment[]>([]);
  const releasedPreviewUrlsRef = useRef(new Set<string>());
  const revisionRef = useRef(0);
  const stashPulseTimeoutRef = useRef<number | null>(null);
  const stashInFlightRef = useRef<Set<string>>(new Set());
  const stashQueue = usePromptStashStore((state) => state.entries);
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry);
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry);
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages);

  const releaseAttachments = useCallback((items: readonly BotPromptAttachment[]) => {
    const unreleased = items.filter((attachment) => {
      if (
        attachment.previewUrl === null ||
        releasedPreviewUrlsRef.current.has(attachment.previewUrl)
      ) {
        return false;
      }

      releasedPreviewUrlsRef.current.add(attachment.previewUrl);

      return true;
    });

    releaseBotPromptAttachments(unreleased);
  }, []);

  const persistDraft = useCallback(
    (next: string) => {
      revisionRef.current += 1;
      setDraft(next);
      setIsStashMenuOpen(false);

      if (draftKey) writeBotDraft(draftKey, next);
    },
    [draftKey],
  );

  useEffect(() => {
    revisionRef.current += 1;
    setDraft(draftKey ? readBotDraft(draftKey) : "");
    setDictationGeneration((generation) => generation + 1);
  }, [draftKey]);
  useEffect(
    () => () => {
      if (stashPulseTimeoutRef.current !== null) {
        window.clearTimeout(stashPulseTimeoutRef.current);
      }

      releaseAttachments(attachmentsRef.current);
      attachmentsRef.current = [];
    },
    [releaseAttachments],
  );

  const addFiles = (next: FileList | readonly File[]) => {
    revisionRef.current += 1;
    const added = createBotPromptAttachments(Array.from(next));
    const updated = [...attachmentsRef.current, ...added];
    attachmentsRef.current = updated;
    setAttachments(updated);
  };

  const removeAttachment = (attachmentId: string) => {
    const removed = attachmentsRef.current.find((attachment) => attachment.id === attachmentId);

    if (!removed) return;
    revisionRef.current += 1;
    const updated = attachmentsRef.current.filter((attachment) => attachment.id !== attachmentId);
    attachmentsRef.current = updated;
    setAttachments(updated);
    setFailedAttachmentIds((current) => {
      if (!current.has(attachmentId)) return current;
      const next = new Set(current);
      next.delete(attachmentId);

      return next;
    });

    if (expandedAttachmentId === attachmentId) {
      setExpandedAttachmentId(null);
    }

    releaseAttachments([removed]);
  };

  const markAttachmentPreviewFailed = (attachmentId: string) => {
    setFailedAttachmentIds((current) => new Set(current).add(attachmentId));

    if (expandedAttachmentId === attachmentId) setExpandedAttachmentId(null);
  };

  const expandedPreview =
    expandedAttachmentId === null
      ? null
      : buildBotPromptAttachmentPreview(attachments, expandedAttachmentId, failedAttachmentIds);

  const pulseStashBadge = useCallback(() => {
    if (stashPulseTimeoutRef.current !== null) {
      window.clearTimeout(stashPulseTimeoutRef.current);
    }

    setStashPulse((current) => ({ key: current.key + 1, active: true }));
    stashPulseTimeoutRef.current = window.setTimeout(() => {
      setStashPulse((current) => ({ ...current, active: false }));
      stashPulseTimeoutRef.current = null;
    }, 220);
  }, []);

  const restoreStashEntry = useCallback(
    (candidate: PromptStashEntry) => {
      const { entry, durable } = takeStashEntry(candidate.id);

      if (!entry) return;
      persistDraft(restoreBotStashPrompt(draft, entry.prompt));

      const hydrated = hydrateImagesFromPersisted(entry.attachments).map((image) => image.file);
      const currentAttachments = attachmentsRef.current;

      const existingKeys = new Set(
        currentAttachments.map(
          (attachment) =>
            `${attachment.file.type}\0${attachment.file.size}\0${attachment.file.name}`,
        ),
      );

      const unique = hydrated.filter((file) => {
        const key = `${file.type}\0${file.size}\0${file.name}`;

        if (existingKeys.has(key)) return false;
        existingKeys.add(key);

        return true;
      });

      const capacity = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - currentAttachments.length);
      const restoredFiles = unique.slice(0, capacity);
      const restoredAttachments = createBotPromptAttachments(restoredFiles);
      const updated = [...currentAttachments, ...restoredAttachments];
      attachmentsRef.current = updated;
      setAttachments(updated);
      setIsStashMenuOpen(false);

      const missingImageCount =
        entry.droppedImageNames.length +
        (entry.unreadableImageNames?.length ?? 0) +
        (entry.pendingImageCount ?? 0) +
        (entry.attachments.length - hydrated.length) +
        (unique.length - restoredFiles.length);

      if (missingImageCount > 0) {
        toastManager.add({
          type: "warning",
          title: t("Some images were not restored"),
          description: plural(missingImageCount, {
            one: "{count} image was unavailable or over the attachment limit.",
            other: "{count} images were unavailable or over the attachment limit.",
          }),
        });
      }

      if (!durable) {
        toastManager.add({
          type: "warning",
          title: t("Stash entry may come back"),
          description: t("Browser storage rejected the update."),
        });
      }

      window.requestAnimationFrame(() => promptInputRef.current?.focus());
    },
    [draft, persistDraft, plural, promptInputRef, t, takeStashEntry],
  );

  const deleteStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      const { durable } = takeStashEntry(entry.id);

      if (!durable) {
        toastManager.add({
          type: "warning",
          title: t("Stash entry may come back"),
          description: t("Browser storage rejected the delete."),
        });
      }
    },
    [t, takeStashEntry],
  );

  const stashCurrentPrompt = useCallback(async () => {
    const prompt = draft.trim();
    const stashedAttachments = [...attachmentsRef.current];
    const stashedFiles = stashedAttachments.map((attachment) => attachment.file);

    if (prompt.length === 0 && stashedFiles.length === 0) {
      setIsStashMenuOpen((open) => !open);

      return;
    }

    const snapshotKey = `${draftKey ?? ""}\0${prompt}\0${stashedFiles
      .map((file) => `${file.name}:${file.size}:${file.lastModified}`)
      .join("\0")}`;

    if (stashInFlightRef.current.has(snapshotKey)) return;
    stashInFlightRef.current.add(snapshotKey);

    const entryId = randomUUID();

    try {
      const { evicted, written, durable } = stashEntryToQueue({
        id: entryId,
        createdAt: new Date().toISOString(),
        prompt,
        attachments: [],
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: stashedFiles.length,
      });

      if (!written) {
        toastManager.add({
          type: "error",
          title: t("Could not stash this prompt"),
          description: t("Browser storage rejected the write, so the message was left in place."),
        });

        return;
      }

      persistDraft("");
      setDictationGeneration((generation) => generation + 1);
      const stashedIds = new Set(stashedAttachments.map((attachment) => attachment.id));

      const remaining = attachmentsRef.current.filter(
        (attachment) => !stashedIds.has(attachment.id),
      );

      attachmentsRef.current = remaining;
      setAttachments(remaining);
      setFailedAttachmentIds(
        (current) => new Set([...current].filter((id) => !stashedIds.has(id))),
      );

      if (expandedAttachmentId && stashedIds.has(expandedAttachmentId)) {
        setExpandedAttachmentId(null);
      }

      releaseAttachments(stashedAttachments);
      setIsStashMenuOpen(false);
      pulseStashBadge();

      if (!durable) {
        toastManager.add({
          type: "warning",
          title: t("Stashed prompt will not survive a reload"),
          description: t("Browser storage is unavailable, so the stash is kept for this session."),
        });
      }

      if (evicted) {
        toastManager.add({
          type: "warning",
          title: t("Oldest stashed prompt discarded"),
          description: plural(MAX_STASH_ENTRIES, {
            one: "The stash holds {count} prompt.",
            other: "The stash holds {count} prompts.",
          }),
        });
      }

      const persistedImages: PersistedComposerImageAttachment[] = [];
      const droppedImageNames: string[] = [];
      const unreadableImageNames: string[] = [];

      for (const file of stashedFiles) {
        const result = await compressImageForStash(file);

        if (!result.ok) {
          (result.reason === "too-large" ? droppedImageNames : unreadableImageNames).push(
            file.name,
          );
          continue;
        }

        persistedImages.push({
          id: randomUUID(),
          name: file.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
        });
      }

      const { kept, droppedNames } = partitionStashAttachments(persistedImages);

      const { attached, durable: imagesDurable } = finalizeStashEntryImages(entryId, {
        attachments: kept,
        droppedImageNames: [...droppedImageNames, ...droppedNames],
        unreadableImageNames,
      });

      if (attached && !imagesDurable && durable && stashedFiles.length > 0) {
        toastManager.add({
          type: "warning",
          title: t("Stashed images were not saved"),
          description: t("The text was saved, but the images may be missing after a reload."),
        });
      } else if (!attached && kept.length > 0) {
        toastManager.add({
          type: "warning",
          title: t("Stashed images did not attach"),
          description: t("The prompt was restored or deleted before its images finished saving."),
        });
      }
    } finally {
      stashInFlightRef.current.delete(snapshotKey);
    }
  }, [
    draft,
    draftKey,
    expandedAttachmentId,
    finalizeStashEntryImages,
    persistDraft,
    plural,
    pulseStashBadge,
    releaseAttachments,
    stashEntryToQueue,
    t,
  ]);

  /**
   * Clears the composer and sends its draft. `onCleared` runs once the draft is taken. A
   * failed send restores the draft only when nothing changed in the composer meanwhile.
   */
  const submitDraft = (submission: {
    readonly disabled: boolean;
    readonly mentionBots: ReadonlyArray<MentionBot>;
    readonly onCleared: () => void;
    readonly onSubmit: (
      prompt: string,
      files: readonly File[],
      respondingBotId?: string,
    ) => Promise<boolean>;
  }) => {
    const prompt = draft.trim();
    const submittedAttachments = [...attachmentsRef.current];
    const submittedMention = resolveBotMention(prompt, submission.mentionBots);

    if (!canSubmitBotPrompt(submission.disabled, prompt, submittedAttachments.length)) return;

    if (submittedMention.kind === "ambiguous") return;
    const submittedFailedIds = new Set(failedAttachmentIds);
    persistDraft("");
    setDictationGeneration((generation) => generation + 1);
    submission.onCleared();

    if (draftKey) clearBotDraft(draftKey);
    attachmentsRef.current = [];
    setAttachments([]);
    setFailedAttachmentIds(new Set());
    setExpandedAttachmentId(null);
    const submissionRevision = revisionRef.current;
    void submission
      .onSubmit(
        prompt,
        submittedAttachments.map((attachment) => attachment.file),
        submittedMention.kind === "bot" ? submittedMention.botId : undefined,
      )
      .then(
        (sent) => {
          if (sent) {
            releaseAttachments(submittedAttachments);
            setIsStashMenuOpen(false);

            return;
          }

          if (!isBotPromptSubmissionCurrent(submissionRevision, revisionRef.current)) {
            releaseAttachments(submittedAttachments);

            return;
          }

          revisionRef.current += 1;
          setDraft(prompt);

          if (draftKey) writeBotDraft(draftKey, prompt);
          attachmentsRef.current = submittedAttachments;
          setAttachments(submittedAttachments);
          setFailedAttachmentIds(submittedFailedIds);
        },
        () => undefined,
      );
  };

  return {
    draft,
    persistDraft,
    dictationGeneration,
    attachments,
    expandedAttachmentId,
    setExpandedAttachmentId,
    expandedPreview,
    addFiles,
    removeAttachment,
    markAttachmentPreviewFailed,
    isStashMenuOpen,
    setIsStashMenuOpen,
    stashPulse,
    stashQueue,
    restoreStashEntry,
    deleteStashEntry,
    stashCurrentPrompt,
    submitDraft,
  };
}
