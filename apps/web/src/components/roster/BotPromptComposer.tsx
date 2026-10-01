import { useAtomValue } from "@effect/atom-react";
import { composerActionIsDictation } from "@akeru/client-runtime/dictation";
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

import { shortcutLabelForCommand } from "../../keybindings";
import { useEnvironmentComposerDictation } from "../../lib/useEnvironmentComposerDictation";
import { cn } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { ComposerBanner } from "../chat/ComposerBanner";
import { DictationControls } from "../chat/DictationControls";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { ComposerStashBadge } from "../chat/ComposerStashBadge";
import { ComposerStashMenu } from "../chat/ComposerStashMenu";
import { LoaderMeter } from "../chat/ResponseLoadingState";
import {
  BOT_COMPOSER_QUIET_SURFACE_CLASS_NAME,
  BOT_COMPOSER_SURFACE_CLASS_NAME,
  CONVERSATION_MEASURE_CLASS_NAME,
} from "./botConversationPresentation";
import type { MessageReplyTarget } from "../chat/MessageControls";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { useI18n } from "../../i18n";
import { BotComposerModelControl } from "./BotComposerModelControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useRosterStore } from "./rosterStore";
import { BotPromptAttachments } from "./BotPromptAttachments";
import {
  appendBotMention,
  botComposerState,
  botMentionHint,
  botPromptCommandMenuTrigger,
  canSubmitBotPrompt,
  isBotPromptExpanded,
  type MentionBot,
  resolveBotMention,
} from "./botPromptComposer.logic";
import {
  applyBotPromptMention,
  botPromptMention,
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
import { useBotComposerDraft } from "./useBotComposerDraft";
import { useBotComposerKeyboard } from "./useBotComposerKeyboard";

export {
  appendBotMention,
  botComposerState,
  type BotComposerState,
  type BotMention,
  botMentionHint,
  botPromptCommandMenuTrigger,
  canSubmitBotPrompt,
  isBotPromptExpanded,
  isBotPromptSubmissionCurrent,
  type MentionBot,
  resolveBotMention,
  restoreBotStashPrompt,
  shouldFocusBotPromptForKey,
} from "./botPromptComposer.logic";

const EMPTY_MENTION_BOTS: ReadonlyArray<MentionBot> = [];

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
  quietSurface = false,
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
  quietSurface?: boolean;
  placeholder?: string;
  replyPreview?: MessageReplyTarget | null;
  onCancelReply?: () => void;
  /** Id of the element explaining why Send is off, announced with the Send button. */
  sendBlockedDescriptionId?: string | undefined;
  /** Reports the bot the draft's mention addresses, or null when it addresses none. */
  onAddressedBotChange?: (botId: string | null) => void;
  onSubmit: (prompt: string, files: readonly File[], respondingBotId?: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
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

  const promptInputRef = useRef<HTMLTextAreaElement>(null);

  const {
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
  } = useBotComposerDraft({ draftKey, promptInputRef });

  const mentionHintId = useId();
  const draftMention = resolveBotMention(draft, mentionBots);
  const mentionHint = botMentionHint(draftMention, t);
  const addressedBotId = draftMention.kind === "bot" ? draftMention.botId : null;
  useEffect(() => {
    onAddressedBotChange?.(addressedBotId);
  }, [addressedBotId, onAddressedBotChange]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentionMenuRef = useRef<BotPromptMentionMenuHandle>(null);
  const commandMenuRef = useRef<BotPromptCommandMenuHandle>(null);
  const mentionListboxId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissedMentionStart, setDismissedMentionStart] = useState<number | null>(null);
  const [dismissedCommandStart, setDismissedCommandStart] = useState<number | null>(null);
  const [activeMentionOptionId, setActiveMentionOptionId] = useState<string | null>(null);

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
  useBotComposerKeyboard({
    readOnly,
    keybindings,
    promptInputRef,
    persistDraft,
    stashCurrentPrompt,
  });

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
      className="w-full px-gutter-48rem pb-4 pt-2 sm:px-gutter-48rem-wide sm:pb-6"
      onSubmit={(event) => {
        event.preventDefault();
        submitDraft({
          disabled,
          mentionBots,
          onSubmit,
          // Sending with Enter settles a failed dictation, so the empty composer returns to the mic.
          onCleared: () => {
            if (dictation.status === "failed") dictation.onCancel();
          },
        });
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
              "relative flex min-h-13 flex-col overflow-hidden rounded-1.65rem border shadow-composer-float transition-composer-shape duration-200 ease-out",
              quietSurface
                ? BOT_COMPOSER_QUIET_SURFACE_CLASS_NAME
                : BOT_COMPOSER_SURFACE_CLASS_NAME,
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
              onPreviewError={markAttachmentPreviewFailed}
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
                "field-sizing-content max-h-56 w-full resize-none bg-transparent text-base leading-6 outline-none placeholder:text-muted-foreground/70",
                expanded ? "min-h-16 px-4 pb-13 pt-3" : "min-h-13 px-14 py-0.9rem",
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
                {mentionBots.length === 0 ? (
                  // Attaching is the only prompt action here, so the button opens the picker.
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={t("Attach file")}
                          disabled={readOnly}
                          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => fileInputRef.current?.click()}
                        />
                      }
                    >
                      <PlusIcon className="size-5" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">{t("Attach file")}</TooltipPopup>
                  </Tooltip>
                ) : (
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
                )}
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
