import { useAtomValue } from "@effect/atom-react";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { ArrowUpIcon, AtSignIcon, PaperclipIcon, PlusIcon, XIcon } from "lucide-react";
import { type ComponentProps, useCallback, useEffect, useRef, useState } from "react";

import {
  hydrateImagesFromPersisted,
  type PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { compressImageForStash } from "../../lib/imageCompression";
import { cn, randomUUID } from "../../lib/utils";
import {
  MAX_STASH_ENTRIES,
  partitionStashAttachments,
  usePromptStashStore,
  type PromptStashEntry,
} from "../../promptStashStore";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { ComposerBanner } from "../chat/ComposerBanner";
import { ComposerStashBadge } from "../chat/ComposerStashBadge";
import { ComposerStashMenu } from "../chat/ComposerStashMenu";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { clearBotDraft, readBotDraft, writeBotDraft } from "./botDraftStore";
import { BotModelPicker } from "./BotModelPicker";

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

export function restoreBotStashPrompt(currentPrompt: string, stashedPrompt: string): string {
  if (stashedPrompt.length === 0) return currentPrompt;
  return currentPrompt.trim().length > 0
    ? `${currentPrompt.trimEnd()}\n\n${stashedPrompt}`
    : stashedPrompt;
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
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [draft, setDraft] = useState(() => (draftKey ? readBotDraft(draftKey) : ""));
  const [files, setFiles] = useState<File[]>([]);
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  const [stashPulse, setStashPulse] = useState({ key: 0, active: false });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const stashPulseTimeoutRef = useRef<number | null>(null);
  const stashInFlightRef = useRef<Set<string>>(new Set());
  const stashQueue = usePromptStashStore((state) => state.entries);
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry);
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry);
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages);
  const persistDraft = useCallback(
    (next: string) => {
      setDraft(next);
      setIsStashMenuOpen(false);
      if (draftKey) writeBotDraft(draftKey, next);
    },
    [draftKey],
  );
  const persistDraftRef = useRef(persistDraft);
  persistDraftRef.current = persistDraft;

  useEffect(() => {
    setDraft(draftKey ? readBotDraft(draftKey) : "");
    setFiles([]);
    setIsStashMenuOpen(false);
  }, [draftKey]);
  useEffect(
    () => () => {
      if (stashPulseTimeoutRef.current !== null) {
        window.clearTimeout(stashPulseTimeoutRef.current);
      }
    },
    [],
  );
  const expanded = modelPicker !== null || files.length > 0 || isBotPromptExpanded(draft);
  const addFiles = (next: FileList | readonly File[]) =>
    setFiles((current) =>
      [...current, ...Array.from(next)].slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    );

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
      const nextDraft = restoreBotStashPrompt(draft, entry.prompt);
      persistDraft(nextDraft);

      const hydrated = hydrateImagesFromPersisted(entry.attachments).map((image) => image.file);
      const existingKeys = new Set(files.map((file) => `${file.type}\0${file.size}\0${file.name}`));
      const unique = hydrated.filter((file) => {
        const key = `${file.type}\0${file.size}\0${file.name}`;
        if (existingKeys.has(key)) return false;
        existingKeys.add(key);
        return true;
      });
      const capacity = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - files.length);
      const restored = unique.slice(0, capacity);
      setFiles([...files, ...restored]);
      setIsStashMenuOpen(false);

      const missingImageCount =
        entry.droppedImageNames.length +
        (entry.unreadableImageNames?.length ?? 0) +
        (entry.pendingImageCount ?? 0) +
        (entry.attachments.length - hydrated.length) +
        (unique.length - restored.length);
      if (missingImageCount > 0) {
        toastManager.add({
          type: "warning",
          title: "Some images were not restored",
          description: `${missingImageCount} image${missingImageCount === 1 ? " was" : "s were"} unavailable or over the attachment limit.`,
        });
      }
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stash entry may come back",
          description: "Browser storage rejected the update.",
        });
      }
      window.requestAnimationFrame(() => promptInputRef.current?.focus());
    },
    [draft, files, persistDraft, takeStashEntry],
  );

  const deleteStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      const { durable } = takeStashEntry(entry.id);
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stash entry may come back",
          description: "Browser storage rejected the delete.",
        });
      }
    },
    [takeStashEntry],
  );

  const stashCurrentPrompt = useCallback(async () => {
    const prompt = draft.trim();
    const stashedFiles = [...files];
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
          title: "Could not stash this prompt",
          description: "Browser storage rejected the write, so the message was left in place.",
        });
        return;
      }

      persistDraft("");
      setFiles([]);
      setIsStashMenuOpen(false);
      pulseStashBadge();
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stashed prompt will not survive a reload",
          description: "Browser storage is unavailable, so the stash is kept for this session.",
        });
      }
      if (evicted) {
        toastManager.add({
          type: "warning",
          title: "Oldest stashed prompt discarded",
          description: `The stash holds ${MAX_STASH_ENTRIES} prompts.`,
        });
      }

      const attachments: PersistedComposerImageAttachment[] = [];
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
        attachments.push({
          id: randomUUID(),
          name: file.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
        });
      }
      const { kept, droppedNames } = partitionStashAttachments(attachments);
      const { attached, durable: imagesDurable } = finalizeStashEntryImages(entryId, {
        attachments: kept,
        droppedImageNames: [...droppedImageNames, ...droppedNames],
        unreadableImageNames,
      });
      if (attached && !imagesDurable && durable && stashedFiles.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Stashed images were not saved",
          description: "The text was saved, but the images may be missing after a reload.",
        });
      } else if (!attached && kept.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Stashed images did not attach",
          description: "The prompt was restored or deleted before its images finished saving.",
        });
      }
    } finally {
      stashInFlightRef.current.delete(snapshotKey);
    }
  }, [
    draft,
    draftKey,
    files,
    finalizeStashEntryImages,
    persistDraft,
    pulseStashBadge,
    stashEntryToQueue,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcutCommand = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: false },
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
  }, [keybindings, stashCurrentPrompt]);

  return (
    <form
      data-chat-composer-form="true"
      className="w-full px-4 pb-4 pt-2 sm:px-6 sm:pb-6"
      onSubmit={(event) => {
        event.preventDefault();
        const prompt = draft.trim();
        if (!canSubmitBotPrompt(disabled, prompt, files.length)) return;
        void onSubmit(prompt, files, findMentionedBotId(prompt, mentionBots)).then((sent) => {
          if (sent) {
            persistDraft("");
            if (draftKey) clearBotDraft(draftKey);
            setFiles([]);
            setIsStashMenuOpen(false);
          }
        });
      }}
    >
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
      <div className="relative">
        <div
          data-testid="bot-prompt-composer"
          data-expanded={expanded || undefined}
          className={cn(
            "relative z-10 flex min-h-13 flex-col overflow-hidden rounded-[1.65rem] border border-white/10 bg-foreground/[0.12] shadow-[0_12px_36px_-24px_rgb(0_0_0/80%)] transition-[min-height,border-radius,background-color,box-shadow] duration-200 ease-out dark:bg-white/[0.16]",
            expanded && "min-h-28",
          )}
        >
          {files.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {files.map((file, index) => (
                <span
                  key={`${file.name}:${file.size}:${file.lastModified}`}
                  className="flex max-w-48 items-center gap-1.5 rounded-full bg-background/65 py-1 pe-1 ps-2.5 text-xs"
                >
                  <PaperclipIcon className="size-3" />
                  <span className="truncate">{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      setFiles((current) => current.filter((_, item) => item !== index))
                    }
                    className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
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
              disabled={!canSubmitBotPrompt(disabled, draft, files.length)}
              className="pointer-events-auto flex size-9 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-25"
            >
              <ArrowUpIcon className="size-5" />
            </button>
          </div>
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
    </form>
  );
}
