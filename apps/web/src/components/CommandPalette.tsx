"use client";

import {
  ChartNoAxesColumnIcon,
  MessageCircleIcon,
  MoonIcon,
  PaletteIcon,
  PuzzleIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import { useDeferredValue, useEffect, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";

import { useTheme } from "../hooks/useTheme";
import { isPreviewFocused } from "../lib/previewFocus";
import {
  COMMAND_PALETTE_INPUT_PLACEHOLDER,
  filterCommandPaletteGroups,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
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
  return (
    <CommandDialogPopup
      aria-label="Command palette"
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
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { theme, themeHalves, resolvedTheme, setAppearanceMode } = useTheme();

  // Names the mode you would switch to, so the row reads as a verb.
  const nextAppearance = resolvedTheme === "dark" ? "light" : "dark";
  const actionItems: CommandPaletteActionItem[] = [
    {
      value: "action:toggle-appearance",
      searchTerms: ["theme", "appearance", "dark", "light", "mode", "toggle"],
      title: nextAppearance === "dark" ? "Switch to dark mode" : "Switch to light mode",
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
      searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
      title: "Toggle theme editor",
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
    {
      value: "action:plugins",
      searchTerms: ["plugins", "mcp", "tools", "executor", "composio"],
      title: "Open plugins",
      icon: <PuzzleIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openPlugins();
      },
    },
    {
      value: "action:usage",
      searchTerms: ["usage", "limits", "quota", "plan", "subscription"],
      title: "Open usage",
      icon: <ChartNoAxesColumnIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openUsage();
      },
    },
    {
      value: "action:feedback",
      searchTerms: ["feedback", "help", "bug", "idea"],
      title: "Send feedback",
      icon: <MessageCircleIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openProductFeedback();
      },
    },
    {
      value: "action:settings",
      searchTerms: ["settings", "preferences", "configuration", "keybindings"],
      title: "Open settings",
      icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openSettings();
      },
    },
  ];
  const groups: CommandPaletteGroup[] = [
    { value: "actions", label: "Actions", items: actionItems },
  ];
  const filteredGroups = filterCommandPaletteGroups({ groups, query: deferredQuery });

  function executeItem(item: CommandPaletteActionItem): void {
    if (item.disabled) return;
    setOpen(false);
    void item.run().catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        }),
      );
    });
  }

  return (
    <CommandPaletteContent
      aria-label="Command palette"
      autoHighlight="always"
      footerActionLabel="Select"
      inputProps={{ placeholder: COMMAND_PALETTE_INPUT_PLACEHOLDER }}
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
      />
    </CommandPaletteContent>
  );
}
