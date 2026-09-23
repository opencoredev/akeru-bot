import type { EnvironmentId } from "@t3tools/contracts";
import { rankComposerThreadMentions } from "@t3tools/shared/composerThreadMentions";
import { AtSignIcon, FileIcon, GlobeIcon, MessageSquareIcon, XIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { useComposerPathSearch, useThreadSearch } from "../../state/queries";
import {
  CHAT_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
} from "../composerInlineChip";
import {
  type BotPromptMentionBot,
  type BotPromptMentionChip,
  type BotPromptMentionItem,
  type BotPromptMentionTrigger,
  botPromptMentionChips,
  botPromptThreadQuery,
  buildBotPromptMentionItems,
  isBotPromptThreadQuery,
} from "./botPromptMentions.logic";

/**
 * Where `@browser`, `@chat:`, and file mentions resolve: the chat's environment,
 * its project, and the project folder searched for files.
 */
export interface BotPromptMentionScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: string | null;
  readonly projectId: string | null;
  readonly cwd: string | null;
}

export interface BotPromptMentionMenuHandle {
  /** Handles picker keys. Returns true when the key was consumed. */
  readonly handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * Mentions resolve in the chat's own environment. Before a chat has its first turn
 * there is no thread yet, so every visible chat in the primary environment is offered.
 */
export function useBotPromptMentionScope(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadRef:
    | { readonly environmentId: EnvironmentId; readonly threadId: string }
    | null
    | undefined;
  readonly projectId: string | null | undefined;
  readonly cwd: string | null | undefined;
}): BotPromptMentionScope | null {
  const environmentId = input.threadRef?.environmentId ?? input.environmentId;
  const threadId = input.threadRef?.threadId ?? null;
  const projectId = input.projectId ?? null;
  const cwd = input.cwd ?? null;
  return useMemo(
    () => (environmentId ? { environmentId, threadId, projectId, cwd } : null),
    [cwd, environmentId, projectId, threadId],
  );
}

const NO_ENVIRONMENT = "" as EnvironmentId;
const NO_ENVIRONMENTS: ReadonlyArray<EnvironmentId> = [];

export function botPromptMentionOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

/**
 * The `@` picker. Mounted only while an `@` token is being typed, so the thread
 * shell and settings subscriptions stay off the composer's typing path.
 */
export function BotPromptMentionMenu({
  ref,
  listboxId,
  trigger,
  scope,
  bots,
  onSelect,
  onClose,
  onActiveOptionChange,
}: {
  ref: Ref<BotPromptMentionMenuHandle>;
  listboxId: string;
  trigger: BotPromptMentionTrigger;
  scope: BotPromptMentionScope | null;
  bots: ReadonlyArray<BotPromptMentionBot>;
  onSelect: (item: BotPromptMentionItem) => void;
  onClose: () => void;
  onActiveOptionChange: (optionId: string | null) => void;
}) {
  const { t } = useI18n();
  const mentionKindDescription: Record<Exclude<BotPromptMentionItem["kind"], "path">, string> = {
    browser: t("Preview browser"),
    bot: t("Bot"),
    thread: t("Chat"),
  };
  const browserAccess = useEnvironmentSettings(
    scope?.environmentId ?? NO_ENVIRONMENT,
    (settings) => settings.enableAgentBrowserAccess,
  );
  const shells = useThreadShells();
  const threadQuery = botPromptThreadQuery(trigger.query);
  const search = useThreadSearch(scope ? [scope.environmentId] : NO_ENVIRONMENTS, threadQuery);
  const threads = useMemo(() => {
    if (!scope) return [];
    const matchedIds = new Set(
      search.matches
        .filter((match) => match.environmentId === scope.environmentId)
        .map((match) => match.threadId as string),
    );
    return rankComposerThreadMentions(
      shells.filter((shell) => shell.environmentId === scope.environmentId),
      {
        query: threadQuery,
        currentThreadId: scope.threadId,
        currentProjectId: scope.projectId,
        matchedIds,
      },
    );
  }, [scope, search.matches, shells, threadQuery]);
  // `@chat:` names a chat outright; any other query may also be a workspace path.
  const searchesPaths = scope !== null && !isBotPromptThreadQuery(trigger.query);
  const pathSearch = useComposerPathSearch({
    environmentId: scope?.environmentId ?? null,
    cwd: searchesPaths ? scope.cwd : null,
    query: searchesPaths ? trigger.query : null,
  });
  const items = buildBotPromptMentionItems({
    query: trigger.query,
    browserAvailable: scope !== null && browserAccess,
    bots,
    threads,
    paths: pathSearch.entries,
  });
  const [active, setActive] = useState({ query: trigger.query, index: 0 });
  const activeIndex =
    active.query === trigger.query ? Math.min(active.index, Math.max(0, items.length - 1)) : 0;
  const activeOptionId = items.length > 0 ? botPromptMentionOptionId(listboxId, activeIndex) : null;

  useEffect(() => {
    onActiveOptionChange(activeOptionId);
  }, [activeOptionId, onActiveOptionChange]);
  useEffect(() => () => onActiveOptionChange(null), [onActiveOptionChange]);

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown: (event) => {
        if (event.nativeEvent.isComposing) return false;
        if (event.key === "Escape") {
          onClose();
          return true;
        }
        if (items.length === 0) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActive({
            query: trigger.query,
            index: (activeIndex + step + items.length) % items.length,
          });
          return true;
        }
        if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
          const item = items[activeIndex];
          if (item) onSelect(item);
          return true;
        }
        return false;
      },
    }),
    [activeIndex, items, onClose, onSelect, trigger.query],
  );

  if (items.length === 0) return null;
  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label={t("Mention")}
      data-testid="bot-prompt-mention-menu"
      className="absolute inset-x-0 bottom-full z-20 mb-2 max-h-72 overflow-y-auto rounded-2xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      {items.map((item, index) => {
        const Icon =
          item.kind === "browser"
            ? GlobeIcon
            : item.kind === "bot"
              ? AtSignIcon
              : item.kind === "path"
                ? FileIcon
                : MessageSquareIcon;
        return (
          <div
            key={item.key}
            id={botPromptMentionOptionId(listboxId, index)}
            role="option"
            aria-selected={index === activeIndex}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm",
              index === activeIndex && "bg-accent text-accent-foreground",
            )}
            // Keep focus in the prompt so the caret and draft stay put.
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => {
              if (index !== activeIndex) setActive({ query: trigger.query, index });
            }}
            onClick={() => onSelect(item)}
          >
            <Icon aria-hidden="true" className="size-4 shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate">
              {item.kind === "browser" ? t("Browser") : item.label}
            </span>
            <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
              {item.kind === "path"
                ? item.directory
                : item.kind === "bot" && item.detail !== null
                  ? item.detail
                  : mentionKindDescription[item.kind]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const MENTION_CHIP_PATTERN = /(^|\s)@(browser|chat:|bot:)/;

/** Cheap check so the chip strip, and its thread shell subscription, mount only when needed. */
export function draftHasMentionChips(draft: string): boolean {
  return MENTION_CHIP_PATTERN.test(draft);
}

/** The browser, chat, and exact-bot mentions in the draft, each with a remove button. */
export function BotPromptMentionChips({
  draft,
  bots,
  onRemove,
}: {
  draft: string;
  bots: ReadonlyArray<BotPromptMentionBot>;
  onRemove: (chip: BotPromptMentionChip) => void;
}) {
  const { t } = useI18n();
  const shells = useThreadShells();
  const chips = useMemo(() => {
    const titles = new Map(shells.map((shell) => [shell.id as string, shell.title]));
    return botPromptMentionChips(
      draft,
      (threadId) => titles.get(threadId) ?? t("Unknown chat"),
      (botId) => bots.find((bot) => bot.id === botId)?.name ?? t("Unknown bot"),
    ).map((chip) => (chip.kind === "browser" ? { ...chip, label: t("Browser") } : chip));
  }, [bots, draft, shells, t]);
  if (chips.length === 0) return null;
  return (
    <ul
      aria-label={t("Mentions")}
      className="flex flex-wrap gap-1.5 px-3 pt-3 text-[15px]"
      data-testid="bot-prompt-mention-chips"
    >
      {chips.map((chip) => {
        const Icon =
          chip.kind === "browser"
            ? GlobeIcon
            : chip.kind === "bot"
              ? AtSignIcon
              : MessageSquareIcon;
        return (
          <li key={chip.key} className={COMPOSER_INLINE_CHIP_CLASS_NAME}>
            <Icon aria-hidden="true" className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME} />
            <span className={CHAT_INLINE_CHIP_LABEL_CLASS_NAME}>{chip.label}</span>
            <button
              type="button"
              aria-label={t("Remove {name}", { name: chip.label })}
              className={COMPOSER_INLINE_CHIP_DISMISS_BUTTON_CLASS_NAME}
              onClick={() => onRemove(chip)}
            >
              <XIcon aria-hidden="true" className="size-full" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
