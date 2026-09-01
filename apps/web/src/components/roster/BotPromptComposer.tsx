import { ArrowUpIcon, AtSignIcon, PaperclipIcon, PlusIcon } from "lucide-react";
import { type ComponentProps, useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { clearBotDraft, readBotDraft, writeBotDraft } from "./botDraftStore";
import { BotModelPicker } from "./BotModelPicker";
import {
  BotPromptAttachments,
  buildBotPromptAttachmentPreview,
  createBotPromptAttachments,
  releaseBotPromptAttachments,
  type BotPromptAttachment,
} from "./BotPromptAttachments";

type BotModelPickerProps = Pick<
  ComponentProps<typeof BotModelPicker>,
  "activeInstanceId" | "model" | "instanceEntries" | "modelOptionsByInstance" | "onChange"
>;

export function isBotPromptExpanded(prompt: string): boolean {
  return prompt.includes("\n") || prompt.length > 80;
}

export function canSubmitBotPrompt(disabled: boolean, prompt: string, fileCount: number): boolean {
  return !disabled && (prompt.trim().length > 0 || fileCount > 0);
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

export interface MentionBot {
  readonly id: string;
  readonly name: string;
}

const EMPTY_MENTION_BOTS: ReadonlyArray<MentionBot> = [];

export function findMentionedBotId(
  prompt: string,
  bots: ReadonlyArray<MentionBot>,
): string | undefined {
  const mentions = bots.flatMap((bot) => {
    const token = `@${bot.name}`;
    const index = prompt.lastIndexOf(token);
    if (index < 0) return [];
    const before = prompt[index - 1];
    const after = prompt[index + token.length];
    return (before === undefined || /\s/.test(before)) && (after === undefined || /\s/.test(after))
      ? [{ id: bot.id, index }]
      : [];
  });
  return mentions.toSorted((left, right) => right.index - left.index)[0]?.id;
}

export function BotPromptComposer({
  botName,
  draftKey,
  disabled,
  mentionBots = EMPTY_MENTION_BOTS,
  modelPicker,
  onSubmit,
}: {
  botName: string;
  draftKey?: string;
  disabled: boolean;
  mentionBots?: ReadonlyArray<MentionBot>;
  modelPicker: BotModelPickerProps | null;
  onSubmit: (prompt: string, files: readonly File[], respondingBotId?: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(() => (draftKey ? readBotDraft(draftKey) : ""));
  const [attachments, setAttachments] = useState<BotPromptAttachment[]>([]);
  const [expandedAttachmentId, setExpandedAttachmentId] = useState<string | null>(null);
  const attachmentsRef = useRef<BotPromptAttachment[]>([]);
  const releasedPreviewUrlsRef = useRef(new Set<string>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const releaseAttachments = (items: readonly BotPromptAttachment[]) => {
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
  };
  const persistDraft = (next: string) => {
    setDraft(next);
    if (draftKey) writeBotDraft(draftKey, next);
  };
  const persistDraftRef = useRef(persistDraft);
  persistDraftRef.current = persistDraft;

  useEffect(() => {
    setDraft(draftKey ? readBotDraft(draftKey) : "");
  }, [draftKey]);
  useEffect(
    () => () => {
      releaseAttachments(attachmentsRef.current);
      attachmentsRef.current = [];
    },
    [],
  );

  const expanded = modelPicker !== null || attachments.length > 0 || isBotPromptExpanded(draft);
  const addFiles = (next: FileList | readonly File[]) => {
    const added = createBotPromptAttachments(Array.from(next));
    const updated = [...attachmentsRef.current, ...added];
    attachmentsRef.current = updated;
    setAttachments(updated);
  };
  const removeAttachment = (attachmentId: string) => {
    const removed = attachmentsRef.current.find((attachment) => attachment.id === attachmentId);
    if (!removed) return;
    const updated = attachmentsRef.current.filter((attachment) => attachment.id !== attachmentId);
    attachmentsRef.current = updated;
    setAttachments(updated);
    if (expandedAttachmentId === attachmentId) {
      setExpandedAttachmentId(null);
    }
    releaseAttachments([removed]);
  };
  const expandedPreview =
    expandedAttachmentId === null
      ? null
      : buildBotPromptAttachmentPreview(attachments, expandedAttachmentId);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <form
      className="w-full px-4 pb-4 pt-2 sm:px-6 sm:pb-6"
      onSubmit={(event) => {
        event.preventDefault();
        const prompt = draft.trim();
        const submittedAttachments = [...attachmentsRef.current];
        if (!canSubmitBotPrompt(disabled, prompt, submittedAttachments.length)) return;
        const submittedIds = new Set(submittedAttachments.map((attachment) => attachment.id));
        void onSubmit(
          prompt,
          submittedAttachments.map((attachment) => attachment.file),
          findMentionedBotId(prompt, mentionBots),
        ).then(
          (sent) => {
            if (!sent) return;
            persistDraft("");
            if (draftKey) clearBotDraft(draftKey);
            const remaining = attachmentsRef.current.filter(
              (attachment) => !submittedIds.has(attachment.id),
            );
            attachmentsRef.current = remaining;
            setAttachments(remaining);
            if (expandedAttachmentId && submittedIds.has(expandedAttachmentId)) {
              setExpandedAttachmentId(null);
            }
            releaseAttachments(submittedAttachments);
          },
          () => undefined,
        );
      }}
    >
      <div
        data-testid="bot-prompt-composer"
        data-expanded={expanded || undefined}
        className={cn(
          "relative flex min-h-13 flex-col overflow-hidden rounded-[1.65rem] border border-white/10 bg-foreground/[0.12] shadow-[0_12px_36px_-24px_rgb(0_0_0/80%)] transition-[min-height,border-radius,background-color,box-shadow] duration-200 ease-out dark:bg-white/[0.16]",
          expanded && "min-h-28",
        )}
      >
        <BotPromptAttachments
          attachments={attachments}
          className="px-3 pt-3"
          onExpand={setExpandedAttachmentId}
          onRemove={removeAttachment}
        />
        <textarea
          ref={promptInputRef}
          aria-label={`Message ${botName}`}
          data-testid="bot-prompt-input"
          placeholder={`Message ${botName}`}
          rows={1}
          value={draft}
          className={cn(
            "field-sizing-content max-h-56 w-full resize-none bg-transparent text-[15px] leading-6 outline-none placeholder:text-muted-foreground/70",
            expanded ? "min-h-16 px-4 pb-2 pt-3" : "min-h-13 px-14 py-[0.9rem]",
          )}
          onChange={(event) => persistDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          onPaste={(event) => {
            if (event.clipboardData.files.length > 0) addFiles(event.clipboardData.files);
          }}
        />
        <div
          data-testid="bot-prompt-controls"
          className={cn(
            "pointer-events-none flex items-center justify-between",
            expanded ? "px-2 pb-2" : "absolute inset-x-2 bottom-2",
          )}
        >
          <div className="pointer-events-auto flex min-w-0 items-center gap-1">
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Add to prompt"
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/8"
                  />
                }
              >
                <PlusIcon className="size-5" />
              </MenuTrigger>
              <MenuPopup align="start" side="top" sideOffset={8}>
                <MenuItem onClick={() => fileInputRef.current?.click()}>
                  <PaperclipIcon />
                  Attach image
                </MenuItem>
                {mentionBots.map((bot) => (
                  <MenuItem
                    key={bot.id}
                    onClick={() =>
                      setDraft(
                        (current) =>
                          `${current}${current && !/\s$/.test(current) ? " " : ""}@${bot.name} `,
                      )
                    }
                  >
                    <AtSignIcon />
                    Mention {bot.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
            {modelPicker ? (
              <BotModelPicker
                activeInstanceId={modelPicker.activeInstanceId}
                model={modelPicker.model}
                instanceEntries={modelPicker.instanceEntries}
                modelOptionsByInstance={modelPicker.modelOptionsByInstance}
                onChange={modelPicker.onChange}
              />
            ) : null}
          </div>
          <button
            type="submit"
            aria-label="Send message"
            disabled={!canSubmitBotPrompt(disabled, draft, attachments.length)}
            className="pointer-events-auto flex size-9 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-25"
          >
            <ArrowUpIcon className="size-5" />
          </button>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
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
