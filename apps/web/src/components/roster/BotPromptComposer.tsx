import { useAtomValue } from "@effect/atom-react";
import { composerActionIsDictation } from "@t3tools/client-runtime/dictation";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import {
  type ComposerBotMention,
  resolveComposerBotMention,
} from "@t3tools/shared/composerBotMentions";
import {
  ArrowUpIcon,
  AtSignIcon,
  CornerDownRightIcon,
  PaperclipIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

import {
  hydrateImagesFromPersisted,
  type PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { compressImageForStash } from "../../lib/imageCompression";
import { useEnvironmentComposerDictation } from "../../lib/useEnvironmentComposerDictation";
import { cn, randomUUID } from "../../lib/utils";
import {
  MAX_STASH_ENTRIES,
  partitionStashAttachments,
  usePromptStashStore,
  type PromptStashEntry,
} from "../../promptStashStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { createTranslator, type TranslationParams } from "@t3tools/client-runtime/i18n";
import { ComposerBanner } from "../chat/ComposerBanner";
import { DictationControls } from "../chat/DictationControls";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { ComposerStashBadge } from "../chat/ComposerStashBadge";
import { ComposerStashMenu } from "../chat/ComposerStashMenu";
import { LoaderMeter } from "../chat/ResponseLoadingState";
import { CONVERSATION_MEASURE_CLASS_NAME } from "./botConversationPresentation";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { useI18n } from "../../i18n";
import { BotComposerModelControl } from "./BotComposerModelControl";
import { clearBotDraft, readBotDraft, writeBotDraft } from "./botDraftStore";
import { useRosterStore } from "./rosterStore";
import {
  BotPromptAttachments,
  buildBotPromptAttachmentPreview,
  createBotPromptAttachments,
  releaseBotPromptAttachments,
  type BotPromptAttachment,
} from "./BotPromptAttachments";
import {
  applyBotPromptMention,
  botPromptMention,
  type BotPromptMentionBot,
  botPromptMentionTrigger,
  type BotPromptMentionItem,
  removeBotPromptMention,
} from "./botPromptMentions.logic";
import { applyBotPromptCommand, botPromptCommandTrigger } from "./botPromptCommands.logic";
import { BotPromptCommandMenu, type BotPromptCommandMenuHandle } from "./BotPromptCommandMenu";
import type { ComposerProviderCatalog } from "../chat/composerProviderMenuItems";
import {
  BotPromptMentionChips,
  BotPromptMentionMenu,
  type BotPromptMentionMenuHandle,
  type BotPromptMentionScope,
  draftHasMentionChips,
} from "./BotPromptMentions";

export type BotComposerState = "stopped" | "sending" | "ready" | "empty";

/**
 * The composer's visible state. `stopped` means sending is unavailable, `sending` means a
 * turn is still running, `ready` means this draft can go now. A running turn never blocks a
 * ready draft: a follow-up still sends and queues behind the turn.
 */
export function botComposerState(input: {
  readonly disabled: boolean;
  readonly busy: boolean;
  readonly canSubmit: boolean;
}): BotComposerState {
  if (input.disabled) return "stopped";
  if (input.busy) return "sending";
  return input.canSubmit ? "ready" : "empty";
}

export function isBotPromptExpanded(prompt: string): boolean {
  return prompt.includes("\n") || prompt.length > 80;
}

export function canSubmitBotPrompt(disabled: boolean, prompt: string, fileCount: number): boolean {
  return !disabled && (prompt.trim().length > 0 || fileCount > 0);
}

export function isBotPromptSubmissionCurrent(
  submissionRevision: number,
  currentRevision: number,
): boolean {
  return submissionRevision === currentRevision;
}

/** Appends a bot mention token, `@Name` or `@bot:<id>`, with the spacing the parser needs. */
export function appendBotMention(draft: string, mention: string): string {
  return `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${mention} `;
}

export function shouldFocusBotPromptForKey(input: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly defaultPrevented: boolean;
  readonly editableTarget: boolean;
  readonly isComposing: boolean;
  readonly key: string;
  readonly metaKey: boolean;
}): boolean {
  return (
    !input.altKey &&
    !input.ctrlKey &&
    !input.defaultPrevented &&
    !input.editableTarget &&
    !input.isComposing &&
    !input.metaKey &&
    input.key.length === 1
  );
}

export type MentionBot = BotPromptMentionBot;

const EMPTY_MENTION_BOTS: ReadonlyArray<MentionBot> = [];

export type BotMention = ComposerBotMention;

// Resolves the latest whole-word @BotName or @bot:<id>. A bare name shared by two bots
// cannot be routed honestly; the @ menu inserts the id token for those.
export function resolveBotMention(prompt: string, bots: ReadonlyArray<MentionBot>): BotMention {
  return resolveComposerBotMention(prompt, bots);
}

type TranslateMessage = (message: string, params?: TranslationParams) => string;

const translateEnglish: TranslateMessage = createTranslator("en").translate;

export function botMentionHint(
  mention: BotMention,
  t: TranslateMessage = translateEnglish,
): string | null {
  return mention.kind === "ambiguous"
    ? t("More than one bot here is named {name}. Pick one from the @ menu to mention it.", {
        name: mention.name,
      })
    : null;
}

export function restoreBotStashPrompt(currentPrompt: string, stashedPrompt: string): string {
  if (stashedPrompt.length === 0) return currentPrompt;
  return currentPrompt.trim().length > 0
    ? `${currentPrompt.trimEnd()}\n\n${stashedPrompt}`
    : stashedPrompt;
}

/**
 * The `$` or `/` token the command picker opens for. A null catalog still opens it so
 * the picker can say a provider is missing; only an omitted catalog turns it off.
 */
export function botPromptCommandMenuTrigger(input: {
  readonly draft: string;
  readonly caret: number | null;
  readonly readOnly: boolean;
  readonly commandCatalog: ComposerProviderCatalog | null | undefined;
}) {
  if (input.readOnly || input.commandCatalog === undefined || input.caret === null) return null;
  return botPromptCommandTrigger(input.draft, input.caret);
}

export function BotPromptComposer({
  botName,
  draftKey,
  disabled,
  readOnly = false,
  mentionBots = EMPTY_MENTION_BOTS,
  mentionScope = null,
  commandCatalog,
  activitySlot = null,
  busy = false,
  pendingActionSlot = null,
  placeholder,
  replyPreview,
  onCancelReply,
  sendBlockedDescriptionId,
  onAddressedBotChange,
  onSubmit,
}: {
  botName: string;
  draftKey?: string;
  disabled: boolean;
  readOnly?: boolean;
  mentionBots?: ReadonlyArray<MentionBot>;
  /** Enables `@browser` and `@chat:` mentions for this chat's environment. */
  mentionScope?: BotPromptMentionScope | null;
  /**
   * The answering provider's skills and commands, offered by the `$` and `/` pickers.
   * Null keeps the pickers open with a connect-a-provider line; omit it to turn them off.
   */
  commandCatalog?: ComposerProviderCatalog | null;
  /** Live turn status, docked above the prompt box where it stays visible without scrolling. */
  activitySlot?: ReactNode;
  /** A turn is still running, so sending again would queue behind it. */
  busy?: boolean;
  /** Rendered above the prompt box so a pending decision reads as part of the composer. */
  pendingActionSlot?: ReactNode;
  placeholder?: string;
  replyPreview?: { readonly label: string; readonly text: string } | null;
  onCancelReply?: () => void;
  /** Id of the element explaining why Send is off, announced with the Send button. */
  sendBlockedDescriptionId?: string | undefined;
  /** Reports the bot the draft's mention addresses, or null when it addresses none. */
  onAddressedBotChange?: (botId: string | null) => void;
  onSubmit: (prompt: string, files: readonly File[], respondingBotId?: string) => Promise<boolean>;
}) {
  const { t, plural } = useI18n();
  const prefersReducedMotion = useReducedMotion();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // A bot chat keys its draft by bot id; group and onboarding composers namespace
  // theirs, so a key that names a live bot is the one composer that speaks for it.
  const composerBotId = useRosterStore((state) =>
    draftKey !== undefined &&
    state.bots.some((bot) => bot.id === draftKey && bot.archivedAt === null)
      ? draftKey
      : null,
  );
  const [draft, setDraft] = useState(() => (draftKey ? readBotDraft(draftKey) : ""));
  // Bumped whenever the draft is sent, stashed, or swapped, so a late transcript is dropped.
  const [dictationGeneration, setDictationGeneration] = useState(0);
  const mentionHintId = useId();
  const draftMention = resolveBotMention(draft, mentionBots);
  const mentionHint = botMentionHint(draftMention, t);
  const addressedBotId = draftMention.kind === "bot" ? draftMention.botId : null;
  useEffect(() => {
    onAddressedBotChange?.(addressedBotId);
  }, [addressedBotId, onAddressedBotChange]);
  const [attachments, setAttachments] = useState<BotPromptAttachment[]>([]);
  const [failedAttachmentIds, setFailedAttachmentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedAttachmentId, setExpandedAttachmentId] = useState<string | null>(null);
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  const [stashPulse, setStashPulse] = useState({ key: 0, active: false });
  const attachmentsRef = useRef<BotPromptAttachment[]>([]);
  const releasedPreviewUrlsRef = useRef(new Set<string>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const mentionMenuRef = useRef<BotPromptMentionMenuHandle>(null);
  const commandMenuRef = useRef<BotPromptCommandMenuHandle>(null);
  const mentionListboxId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissedMentionStart, setDismissedMentionStart] = useState<number | null>(null);
  const [dismissedCommandStart, setDismissedCommandStart] = useState<number | null>(null);
  const [activeMentionOptionId, setActiveMentionOptionId] = useState<string | null>(null);
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
  const persistDraftRef = useRef(persistDraft);
  persistDraftRef.current = persistDraft;

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

  const hasMentionChips = mentionScope !== null && draftHasMentionChips(draft);
  const expanded =
    attachments.length > 0 || replyPreview != null || hasMentionChips || isBotPromptExpanded(draft);
  const mentionsEnabled = !readOnly && (mentionScope !== null || mentionBots.length > 0);
  const candidateMentionTrigger =
    mentionsEnabled && caret !== null ? botPromptMentionTrigger(draft, caret) : null;
  const mentionTrigger =
    candidateMentionTrigger && candidateMentionTrigger.rangeStart !== dismissedMentionStart
      ? candidateMentionTrigger
      : null;
  const selectMention = useCallback(
    (item: BotPromptMentionItem) => {
      const input = promptInputRef.current;
      if (!input || input.selectionStart === null) return;
      const trigger = botPromptMentionTrigger(input.value, input.selectionStart);
      if (!trigger) return;
      const next = applyBotPromptMention(input.value, trigger, item);
      persistDraft(next.text);
      setCaret(next.caret);
      window.requestAnimationFrame(() => {
        promptInputRef.current?.focus();
        promptInputRef.current?.setSelectionRange(next.caret, next.caret);
      });
    },
    [persistDraft],
  );
  const candidateCommandTrigger = botPromptCommandMenuTrigger({
    draft,
    caret,
    readOnly,
    commandCatalog,
  });
  const commandTrigger =
    candidateCommandTrigger && candidateCommandTrigger.rangeStart !== dismissedCommandStart
      ? candidateCommandTrigger
      : null;
  const selectCommand = useCallback(
    (inserted: string) => {
      const input = promptInputRef.current;
      if (!input || input.selectionStart === null) return;
      const trigger = botPromptCommandTrigger(input.value, input.selectionStart);
      if (!trigger) return;
      const next = applyBotPromptCommand(input.value, trigger, inserted);
      persistDraft(next.text);
      setCaret(next.caret);
      window.requestAnimationFrame(() => {
        promptInputRef.current?.focus();
        promptInputRef.current?.setSelectionRange(next.caret, next.caret);
      });
    },
    [persistDraft],
  );
  const closeCommandMenu = useCallback(() => {
    const input = promptInputRef.current;
    const trigger =
      input && input.selectionStart !== null
        ? botPromptCommandTrigger(input.value, input.selectionStart)
        : null;
    setDismissedCommandStart(trigger?.rangeStart ?? null);
  }, []);
  const closeMentionMenu = useCallback(() => {
    const input = promptInputRef.current;
    const trigger =
      input && input.selectionStart !== null
        ? botPromptMentionTrigger(input.value, input.selectionStart)
        : null;
    setDismissedMentionStart(trigger?.rangeStart ?? null);
  }, []);
  const canSubmit = canSubmitBotPrompt(disabled, draft, attachments.length);
  const composerState = botComposerState({ disabled, busy, canSubmit });
  // Only stands in for the arrow when there is nothing to send, so a follow-up stays sendable.
  const showBusyMeter = busy && !canSubmit;
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
    [draft, persistDraft, plural, t, takeStashEntry],
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

  useEffect(() => {
    if (readOnly) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcutCommand = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: false,
          terminalOpen: false,
          modelPickerOpen: false,
        },
      });
      if (shortcutCommand === "composer.stash") {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat && !isCommandPaletteOpen()) void stashCurrentPrompt();
        return;
      }

      const target = event.target;
      const editableTarget =
        target instanceof Element &&
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]',
        ) !== null;

      if (
        !shouldFocusBotPromptForKey({
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          defaultPrevented: event.defaultPrevented,
          editableTarget,
          isComposing: event.isComposing,
          key: event.key,
          metaKey: event.metaKey,
        })
      ) {
        return;
      }

      event.preventDefault();
      persistDraftRef.current(`${promptInputRef.current?.value ?? ""}${event.key}`);
      promptInputRef.current?.focus();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, readOnly, stashCurrentPrompt]);

  const dictation = useEnvironmentComposerDictation({
    threadId: draftKey ?? botName,
    draftId: draftKey ?? botName,
    generation: dictationGeneration,
    getDraft: () => {
      const input = promptInputRef.current;
      const text = input?.value ?? draft;
      const start = input?.selectionStart ?? text.length;
      return { text, selection: { start, end: input?.selectionEnd ?? start } };
    },
    applyDraft: (next) => {
      persistDraft(next.text);
      // Restore the caret after React commits the merged value.
      window.requestAnimationFrame(() => {
        const input = promptInputRef.current;
        if (!input || input.value !== next.text) return;
        input.focus();
        input.setSelectionRange(next.selection.start, next.selection.end);
      });
    },
  });
  useEffect(() => {
    if (dictation.status !== "failed" || !dictation.errorMessage) return;
    toastManager.add({
      type: "error",
      title: t("Could not dictate"),
      description: dictation.errorMessage,
    });
  }, [dictation.errorMessage, dictation.status, t]);
  const showDictation =
    !readOnly &&
    !showBusyMeter &&
    composerActionIsDictation({
      hasDraft: draft.trim().length > 0 || attachments.length > 0,
      status: dictation.status,
    });

  return (
    <form
      data-chat-composer-form="true"
      data-state={composerState}
      aria-disabled={readOnly || undefined}
      className="w-full px-4 pb-4 pt-2 sm:px-6 sm:pb-6"
      onSubmit={(event) => {
        event.preventDefault();
        const prompt = draft.trim();
        const submittedAttachments = [...attachmentsRef.current];
        const submittedMention = resolveBotMention(prompt, mentionBots);
        if (!canSubmitBotPrompt(disabled, prompt, submittedAttachments.length)) return;
        if (submittedMention.kind === "ambiguous") return;
        const submittedFailedIds = new Set(failedAttachmentIds);
        persistDraft("");
        setDictationGeneration((generation) => generation + 1);
        // Sending with Enter settles a failed dictation, so the empty composer returns to the mic.
        if (dictation.status === "failed") dictation.onCancel();
        if (draftKey) clearBotDraft(draftKey);
        attachmentsRef.current = [];
        setAttachments([]);
        setFailedAttachmentIds(new Set());
        setExpandedAttachmentId(null);
        const submissionRevision = revisionRef.current;
        void onSubmit(
          prompt,
          submittedAttachments.map((attachment) => attachment.file),
          submittedMention.kind === "bot" ? submittedMention.botId : undefined,
        ).then(
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
      }}
    >
      <div className={CONVERSATION_MEASURE_CLASS_NAME}>
        <ComposerBanner.Dock className="relative z-0">
          <ComposerBanner.Column>
            {isStashMenuOpen ? (
              <ComposerStashMenu
                entries={stashQueue}
                stashShortcutLabel={shortcutLabelForCommand(keybindings, "composer.stash")}
                onRestore={restoreStashEntry}
                onDelete={deleteStashEntry}
                onClose={() => setIsStashMenuOpen(false)}
              />
            ) : null}
          </ComposerBanner.Column>
          <ComposerStashBadge
            count={stashQueue.length}
            menuOpen={isStashMenuOpen}
            pulseKey={stashPulse.key}
            pulsing={stashPulse.active}
            onToggleMenu={() => setIsStashMenuOpen((open) => !open)}
          />
        </ComposerBanner.Dock>
        {composerBotId !== null ? (
          <div className="mb-1 flex min-w-0 items-center px-1" data-testid="bot-composer-model">
            <BotComposerModelControl botId={composerBotId} disabled={readOnly} />
          </div>
        ) : null}
        <AnimatePresence initial={false}>
          {activitySlot ? (
            <motion.div
              key="activity"
              className="mb-2 px-1"
              data-testid="bot-composer-activity"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={prefersReducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 2 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.16, ease: "easeOut" }}
            >
              {activitySlot}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {pendingActionSlot ? (
            <motion.div
              key="pending-action"
              data-testid="bot-pending-action-motion"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={prefersReducedMotion ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.16, ease: "easeOut" }}
            >
              {pendingActionSlot}
            </motion.div>
          ) : null}
        </AnimatePresence>
        <div className="relative">
          {mentionTrigger ? (
            <BotPromptMentionMenu
              ref={mentionMenuRef}
              listboxId={mentionListboxId}
              trigger={mentionTrigger}
              scope={mentionScope}
              bots={mentionBots}
              onSelect={selectMention}
              onClose={closeMentionMenu}
              onActiveOptionChange={setActiveMentionOptionId}
            />
          ) : null}
          {commandTrigger && commandCatalog !== undefined ? (
            <BotPromptCommandMenu
              ref={commandMenuRef}
              trigger={commandTrigger}
              catalog={commandCatalog}
              onSelect={selectCommand}
              onClose={closeCommandMenu}
            />
          ) : null}
          <div
            data-testid="bot-prompt-composer"
            data-expanded={expanded || undefined}
            className={cn(
              "relative flex min-h-13 flex-col overflow-hidden rounded-[1.65rem] border border-white/10 bg-foreground/[0.12] shadow-[0_12px_36px_-24px_rgb(0_0_0/80%)] transition-[min-height,border-radius,background-color,box-shadow] duration-200 ease-out dark:bg-white/[0.16]",
              expanded && "min-h-28",
              pendingActionSlot ? "rounded-t-md border-t-transparent" : undefined,
            )}
          >
            {/* One line, always the same height, so starting a reply never resizes the box. */}
            {replyPreview ? (
              <div
                className="mx-3 mt-3 flex h-8 items-center gap-2 rounded-lg bg-foreground/8 px-2.5 text-xs"
                data-testid="composer-reply-preview"
              >
                <CornerDownRightIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
                <span className="shrink-0 font-medium">{replyPreview.label}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {replyPreview.text}
                </span>
                <button
                  type="button"
                  aria-label={t("Cancel reply")}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={onCancelReply}
                >
                  <XIcon className="size-3.5" />
                </button>
              </div>
            ) : null}
            <BotPromptAttachments
              attachments={attachments}
              className="px-3 pt-3"
              onExpand={setExpandedAttachmentId}
              onPreviewError={(attachmentId) => {
                setFailedAttachmentIds((current) => new Set(current).add(attachmentId));
                if (expandedAttachmentId === attachmentId) setExpandedAttachmentId(null);
              }}
              onRemove={removeAttachment}
            />
            {hasMentionChips ? (
              <BotPromptMentionChips
                bots={mentionBots}
                draft={draft}
                onRemove={(chip) => {
                  persistDraft(removeBotPromptMention(draft, chip));
                  promptInputRef.current?.focus();
                }}
              />
            ) : null}
            <textarea
              ref={promptInputRef}
              aria-label={t("Message {name}", { name: botName })}
              data-testid="bot-prompt-input"
              placeholder={placeholder ?? t("Message {name}", { name: botName })}
              rows={1}
              value={draft}
              readOnly={readOnly}
              tabIndex={readOnly ? -1 : undefined}
              aria-autocomplete={mentionsEnabled ? "list" : undefined}
              aria-controls={mentionTrigger && activeMentionOptionId ? mentionListboxId : undefined}
              aria-activedescendant={(mentionTrigger && activeMentionOptionId) || undefined}
              className={cn(
                "field-sizing-content max-h-56 w-full resize-none bg-transparent text-[15px] leading-6 outline-none placeholder:text-muted-foreground/70",
                expanded ? "min-h-16 px-4 pb-13 pt-3" : "min-h-13 px-14 py-[0.9rem]",
              )}
              onChange={(event) => {
                const { selectionStart, value } = event.currentTarget;
                persistDraft(value);
                setCaret(selectionStart);
                if (botPromptMentionTrigger(value, selectionStart) === null) {
                  setDismissedMentionStart(null);
                }
                if (botPromptCommandTrigger(value, selectionStart) === null) {
                  setDismissedCommandStart(null);
                }
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onBlur={() => setCaret(null)}
              onKeyDown={(event) => {
                if (
                  (mentionTrigger && mentionMenuRef.current?.handleKeyDown(event)) ||
                  (commandTrigger && commandMenuRef.current?.handleKeyDown(event))
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              onPaste={(event) => {
                if (!readOnly && event.clipboardData.files.length > 0) {
                  addFiles(event.clipboardData.files);
                }
              }}
            />
            <div
              data-testid="bot-prompt-controls"
              /* Pinned to the box corners in every state: growing the draft must not move
             the add or send button out from under the pointer. */
              className="pointer-events-none absolute inset-x-2 bottom-2 flex items-center justify-between"
            >
              <div className="pointer-events-auto flex min-w-0 items-center gap-1">
                <Menu>
                  <MenuTrigger
                    render={
                      <button
                        type="button"
                        aria-label={t("Add to prompt")}
                        disabled={readOnly}
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    }
                  >
                    <PlusIcon className="size-5" />
                  </MenuTrigger>
                  <MenuPopup align="start" side="top" sideOffset={8}>
                    <MenuItem onClick={() => fileInputRef.current?.click()}>
                      <PaperclipIcon />
                      {t("Attach file")}
                    </MenuItem>
                    {mentionBots.map((bot) => {
                      const mention = botPromptMention(bot, mentionBots);
                      return (
                        <MenuItem
                          key={bot.id}
                          onClick={() => persistDraft(appendBotMention(draft, mention.source))}
                        >
                          <AtSignIcon />
                          {t("Mention {name}", { name: bot.name })}
                          {mention.detail ? ` (${mention.detail})` : ""}
                          {bot.canTakeWork === false ? (
                            <span className="ms-auto ps-3 text-xs text-muted-foreground">
                              {t("Cannot take handed-off work")}
                            </span>
                          ) : null}
                        </MenuItem>
                      );
                    })}
                  </MenuPopup>
                </Menu>
              </div>
              {showDictation ? (
                <div
                  className="pointer-events-auto size-9 shrink-0"
                  data-bot-prompt-dictation="true"
                >
                  <DictationControls
                    appearance="send-slot"
                    {...dictation}
                    onBlockedPress={(reason) =>
                      toastManager.add({
                        type: "info",
                        title: t("Dictation unavailable"),
                        description: reason,
                      })
                    }
                  />
                </div>
              ) : (
                <button
                  type="submit"
                  aria-label={
                    showBusyMeter ? t("{name} is working", { name: botName }) : t("Send message")
                  }
                  aria-describedby={
                    [mentionHint ? mentionHintId : null, disabled ? sendBlockedDescriptionId : null]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  data-busy={showBusyMeter || undefined}
                  disabled={!canSubmit || mentionHint !== null}
                  className="pointer-events-auto flex size-9 items-center justify-center rounded-full bg-foreground text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-25 data-busy:opacity-70"
                >
                  {showBusyMeter ? <LoaderMeter /> : <ArrowUpIcon className="size-5" />}
                </button>
              )}
            </div>
          </div>
        </div>
        {mentionHint ? (
          <p id={mentionHintId} role="status" className="px-4 pt-2 text-xs text-muted-foreground">
            {mentionHint}
          </p>
        ) : null}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        aria-label={t("Attach files")}
        accept="image/*,.txt,.md,.markdown,.csv,.json,.yaml,.yml,.toml,.xml,.pdf"
        multiple
        disabled={readOnly}
        className="sr-only"
        onChange={(event) => {
          if (event.currentTarget.files) addFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      {expandedPreview ? (
        <ExpandedImageDialog
          key={`${expandedAttachmentId}:${attachments.map((attachment) => attachment.id).join(":")}`}
          preview={expandedPreview}
          onClose={() => setExpandedAttachmentId(null)}
        />
      ) : null}
    </form>
  );
}
