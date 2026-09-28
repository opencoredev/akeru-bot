"use client";

import {
  ArchiveIcon,
  BotIcon,
  ChartNoAxesColumnIcon,
  ImageIcon,
  LanguagesIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  MoonIcon,
  PaletteIcon,
  PuzzleIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";

import { useTheme } from "../hooks/useTheme";
import { isPreviewFocused } from "../lib/previewFocus";
import { activeComposerModelPicker } from "../composerModelPickerRegistry";
import { useI18n } from "../i18n";
import { activeChatPaletteActions } from "../chatActionsRegistry";
import {
  buildChatCommandPaletteItems,
  buildChatSearchCommandPaletteItems,
  buildLanguageCommandPaletteAction,
  buildModelPickerCommandPaletteAction,
  filterCommandPaletteGroups,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteChat,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import { openSettings } from "~/settingsDialogStore";
import { openProductFeedback } from "~/productFeedbackStore";
import { openPlugins } from "~/pluginsDialogStore";
import { openUsage } from "~/usageDialogStore";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useThreadSearch } from "../state/queries";
import {
  findLatestBotThreadTarget,
  findLatestGroupThreadIds,
  latestGroupThreadKey,
} from "./roster/botThreadRuntime.logic";
import { useRosterStore } from "./roster/rosterStore";
import { resolveShortcutCommand } from "../keybindings";
import { CommandDialog, CommandDialogPopup } from "./ui/command";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function CommandPalette({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme } = useTheme();

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Resolve with the focus context so customized bindings using a
      // documented `when` condition (e.g. previewFocus) still work.
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          previewFocus: isPreviewFocused(),
        },
      });
      if (command === "themeEditor.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleThemeEditorForTheme({
          theme,
          themeHalves,
          initialAppearance: resolvedTheme,
        });
        return;
      }
      if (command !== "commandPalette.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, resolvedTheme, theme, themeHalves]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      {children}
      <CommandPaletteDialog setOpen={setOpen} />
    </CommandDialog>
  );
}

function CommandPaletteDialog(props: { readonly setOpen: (open: boolean) => void }) {
  const { t } = useI18n();
  return (
    <CommandDialogPopup
      aria-label={t("Command palette")}
      className="overflow-hidden p-0"
      data-command-palette="true"
      data-testid="command-palette"
      finalFocus={false}
      onBackdropPointerDown={() => {
        props.setOpen(false);
      }}
    >
      <OpenCommandPaletteDialog setOpen={props.setOpen} />
    </CommandDialogPopup>
  );
}

function OpenCommandPaletteDialog(props: { readonly setOpen: (open: boolean) => void }) {
  const { setOpen } = props;
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme, setAppearanceMode } = useTheme();

  // Names the mode you would switch to, so the row reads as a verb.
  const nextAppearance = resolvedTheme === "dark" ? "light" : "dark";
  const appearanceTitle =
    nextAppearance === "dark" ? t("Switch to dark mode") : t("Switch to light mode");
  const actionItems: CommandPaletteActionItem[] = [
    {
      value: "action:toggle-appearance",
      searchTerms: [appearanceTitle, "theme", "appearance", "dark", "light", "mode", "toggle"],
      title: appearanceTitle,
      icon:
        nextAppearance === "dark" ? (
          <MoonIcon className={ITEM_ICON_CLASS} />
        ) : (
          <SunIcon className={ITEM_ICON_CLASS} />
        ),
      run: async () => {
        setAppearanceMode(nextAppearance);
      },
    },
    {
      value: "action:theme-editor",
      searchTerms: [
        t("Toggle theme editor"),
        "theme",
        "appearance",
        "colors",
        "palette",
        "customize",
      ],
      title: t("Toggle theme editor"),
      icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "themeEditor.toggle",
      run: async () => {
        toggleThemeEditorForTheme({
          theme,
          themeHalves,
          initialAppearance: resolvedTheme,
        });
      },
    },
    buildModelPickerCommandPaletteAction({
      composerHandle: activeComposerModelPicker(),
      scheduleAfterClose: (openModelPicker) => {
        window.requestAnimationFrame(openModelPicker);
      },
      title: t("Change model"),
      icon: <BotIcon className={ITEM_ICON_CLASS} />,
    }),
    {
      value: "action:plugins",
      searchTerms: [t("Open plugins"), "plugins", "mcp", "tools", "executor", "composio"],
      title: t("Open plugins"),
      icon: <PuzzleIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openPlugins();
      },
    },
    {
      value: "action:usage",
      searchTerms: [t("Open usage"), "usage", "limits", "quota", "plan", "subscription"],
      title: t("Open usage"),
      icon: <ChartNoAxesColumnIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openUsage();
      },
    },
    {
      value: "action:feedback",
      searchTerms: [t("Send feedback"), "feedback", "help", "bug", "idea"],
      title: t("Send feedback"),
      icon: <MessageCircleIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openProductFeedback();
      },
    },
    {
      value: "action:image-generation-settings",
      searchTerms: [
        t("Image generation settings"),
        "image generation",
        "images",
        "pictures",
        "chatgpt",
        "grok",
        "settings",
      ],
      title: t("Image generation settings"),
      icon: <ImageIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openSettings("image-generation");
      },
    },
    buildLanguageCommandPaletteAction({
      translate: t,
      openSettings,
      icon: <LanguagesIcon className={ITEM_ICON_CLASS} />,
    }),
    {
      value: "action:archived-chats",
      searchTerms: [t("Archived chats"), "archived", "archive", "unarchive", "restore", "chats"],
      title: t("Archived chats"),
      icon: <ArchiveIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openSettings("archived");
      },
    },
    {
      value: "action:settings",
      searchTerms: [t("Open settings"), "settings", "preferences", "configuration", "keybindings"],
      title: t("Open settings"),
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openSettings();
      },
    },
  ];
  // Read once per open: the palette mounts fresh each time it opens.
  const [chatItems] = useState(() =>
    buildChatCommandPaletteItems({
      actions: activeChatPaletteActions(),
      icon: <MessagesSquareIcon className={ITEM_ICON_CLASS} />,
    }),
  );
  const groups: CommandPaletteGroup[] = [
    ...(chatItems.length > 0 ? [{ value: "chat", label: t("This chat"), items: chatItems }] : []),
    { value: "actions", label: t("Actions"), items: actionItems },
  ];
  // Rows follow the query the input shows, so Enter never runs a row from an
  // earlier query. Message search debounces its own RPC.
  const chatSearch = useChatSearchItems(query);
  const filteredGroups = [
    ...filterCommandPaletteGroups({ groups, query }),
    ...(chatSearch.items.length > 0
      ? [{ value: "chats", label: t("Chats"), items: chatSearch.items }]
      : []),
  ];

  function executeItem(item: CommandPaletteActionItem): void {
    if (item.disabled) return;
    setOpen(false);
    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Unable to run command"),
          description: error instanceof Error ? error.message : t("An unexpected error occurred."),
        }),
      );
    });
  }

  return (
    <CommandPaletteContent
      aria-label={t("Command palette")}
      autoHighlight="always"
      footerActionLabel={t("Select")}
      inputProps={{ placeholder: t("Search commands...") }}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(nextQuery: string) => {
        setHighlightedItemValue(null);
        setQuery(nextQuery);
      }}
      panelClassName="max-h-[min(28rem,70vh)]"
      value={query}
    >
      <CommandPaletteResults
        groups={filteredGroups}
        highlightedItemValue={highlightedItemValue}
        keybindings={keybindings}
        onExecuteItem={executeItem}
        {...(chatSearch.isPending ? { emptyStateMessage: t("Searching chats…") } : {})}
      />
    </CommandPaletteContent>
  );
}

/**
 * The palette's Chats group for a typed query: chat titles from the loaded
 * shells plus message matches from every connected environment. Bot chats open
 * in the bot's view; a group opens its chat. Chats outside the environment this
 * client shows are listed but cannot be opened here.
 */
function useChatSearchItems(query: string): {
  readonly items: CommandPaletteActionItem[];
  readonly isPending: boolean;
} {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const shells = useThreadShells();
  const bots = useRosterStore((state) => state.bots);
  const groups = useRosterStore((state) => state.groups);
  const searchQuery = query.startsWith(">") ? "" : query;
  const connectedEnvironmentIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );
  const search = useThreadSearch(connectedEnvironmentIds, searchQuery);

  const chats = useMemo((): CommandPaletteChat[] => {
    const connected = new Set<string>(connectedEnvironmentIds);
    const labelById = new Map<string, string>(
      environments.map((environment) => [environment.environmentId, environment.label] as const),
    );
    const botById = new Map(bots.map((bot) => [bot.id, bot] as const));
    const groupById = new Map(groups.map((group) => [group.id, group] as const));
    const latestGroupThreadIds = findLatestGroupThreadIds(shells);
    return shells.flatMap((shell): CommandPaletteChat[] => {
      if (
        shell.archivedAt !== null ||
        shell.parentThreadId != null ||
        !connected.has(shell.environmentId)
      ) {
        return [];
      }
      const base = {
        environmentId: shell.environmentId,
        threadId: shell.id,
        title: shell.title,
        updatedAt: shell.updatedAt,
      };
      if (shell.environmentId !== primaryEnvironmentId) {
        if (shell.botId == null && shell.groupId == null) return [];
        return [
          {
            ...base,
            ownerName: null,
            unavailableIn: labelById.get(shell.environmentId) ?? shell.environmentId,
          },
        ];
      }
      const bot = shell.botId ? botById.get(shell.botId) : undefined;
      if (bot && bot.archivedAt === null) {
        return [{ ...base, ownerName: bot.name, unavailableIn: null }];
      }
      // A group shows only its newest chat, so older group chats cannot be opened.
      const group = shell.groupId ? groupById.get(shell.groupId) : undefined;
      if (
        group &&
        latestGroupThreadIds.get(latestGroupThreadKey(shell.environmentId, group.id)) === shell.id
      ) {
        return [{ ...base, ownerName: group.name, unavailableIn: null }];
      }
      return [];
    });
  }, [bots, connectedEnvironmentIds, environments, groups, primaryEnvironmentId, shells]);

  const items = buildChatSearchCommandPaletteItems({
    query: searchQuery,
    chats,
    matches: search.matches,
    untitledLabel: t("Untitled chat"),
    unavailableLabel: (environment) => t("In {environment}", { environment }),
    icon: <MessagesSquareIcon className={ITEM_ICON_CLASS} />,
    openChat: async (chat) => {
      const shell = shells.find(
        (candidate) =>
          candidate.environmentId === chat.environmentId && candidate.id === chat.threadId,
      );
      if (shell?.botId) {
        const botId = shell.botId;
        const newest = findLatestBotThreadTarget(botId, chat.environmentId, shells);
        const roster = useRosterStore.getState();
        roster.selectBot(botId);
        roster.openBotChat(botId, newest?.threadId === chat.threadId ? null : chat.threadId);
        await navigate({ to: "/bots/$botId", params: { botId } });
      } else if (shell?.groupId) {
        await navigate({ to: "/groups/$groupId", params: { groupId: shell.groupId } });
      }
    },
  });
  return { items, isPending: search.isPending };
}
