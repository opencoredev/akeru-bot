import { describe, expect, it, vi } from "vite-plus/test";
import {
  activeComposerModelPicker,
  registerComposerModelPicker,
} from "../composerModelPickerRegistry";
import { activeChatPaletteActions, registerChatPaletteActions } from "../chatActionsRegistry";
import {
  buildChatCommandPaletteItems,
  buildLanguageCommandPaletteAction,
  buildModelPickerCommandPaletteAction,
  filterCommandPaletteGroups,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

function action(value: string, searchTerms: ReadonlyArray<string>) {
  return { value, searchTerms, title: value, icon: null, run: async () => undefined };
}

const ACTIONS: CommandPaletteGroup = {
  value: "actions",
  label: "Actions",
  items: [
    action("action:theme-editor", ["theme", "appearance", "colors"]),
    action("action:settings", ["settings", "preferences", "keybindings"]),
    action("action:plugins", ["plugins", "mcp", "tools"]),
  ],
};

describe("filterCommandPaletteGroups", () => {
  it("returns every group for an empty query", () => {
    expect(filterCommandPaletteGroups({ groups: [ACTIONS], query: "  " })).toEqual([ACTIONS]);
  });

  it("keeps only matching items and drops empty groups", () => {
    const groups = filterCommandPaletteGroups({ groups: [ACTIONS], query: "sett" });
    expect(groups.map((group) => group.items.map((item) => item.value))).toEqual([
      ["action:settings"],
    ]);
    expect(filterCommandPaletteGroups({ groups: [ACTIONS], query: "nothing" })).toEqual([]);
  });

  it("ranks earlier search terms ahead of later ones", () => {
    const group: CommandPaletteGroup = {
      value: "actions",
      label: "Actions",
      items: [action("later", ["open", "theme"]), action("first", ["theme", "open"])],
    };
    const groups = filterCommandPaletteGroups({ groups: [group], query: "theme" });
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["first", "later"]);
  });

  it("ignores a leading > so actions-style queries still match", () => {
    const groups = filterCommandPaletteGroups({ groups: [ACTIONS], query: ">plugins" });
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["action:plugins"]);
  });
});

describe("roadmap palette commands", () => {
  it("keeps stable ids for the language command and matches translated labels", async () => {
    const openSettings = vi.fn();
    const action = buildLanguageCommandPaletteAction({
      translate: () => "Changer la langue",
      openSettings,
      icon: null,
    });
    expect(action.value).toBe("action:language");
    for (const query of ["language", "locale", "langue", "> langue", "简体中文"]) {
      const groups = filterCommandPaletteGroups({
        groups: [{ value: "actions", label: "Actions", items: [action] }],
        query,
      });
      expect(groups[0]?.items[0]?.value).toBe("action:language");
    }
    await action.run();
    expect(openSettings).toHaveBeenCalledExactlyOnceWith("general", "language");
  });

  it("opens the registered composer model picker and disables itself without one", async () => {
    const openModelPicker = vi.fn();
    const scheduleAfterClose = vi.fn((open: () => void) => open());
    const release = registerComposerModelPicker({ openModelPicker });
    const action = buildModelPickerCommandPaletteAction({
      composerHandle: activeComposerModelPicker(),
      scheduleAfterClose,
      title: "Change model",
      icon: null,
    });
    expect(action.disabled).toBe(false);
    await action.run();
    expect(openModelPicker).toHaveBeenCalledOnce();

    release();
    expect(
      buildModelPickerCommandPaletteAction({
        composerHandle: activeComposerModelPicker(),
        scheduleAfterClose,
        title: "Change model",
        icon: null,
      }).disabled,
    ).toBe(true);
  });
});

describe("chat actions in the command palette", () => {
  it("publishes the open chat's actions until that chat unmounts", () => {
    const first = {};
    const second = {};
    const settle = { id: "settle", title: "Settle chat", searchTerms: ["settle"], run: vi.fn() };
    const cleanupFirst = registerChatPaletteActions(first, [settle]);
    expect(activeChatPaletteActions()).toEqual([settle]);

    const cleanupSecond = registerChatPaletteActions(second, []);
    cleanupFirst();
    expect(activeChatPaletteActions()).toEqual([]);
    registerChatPaletteActions(second, [settle]);
    cleanupFirst();
    expect(activeChatPaletteActions()).toEqual([settle]);
    cleanupSecond();
    expect(activeChatPaletteActions()).toEqual([]);
  });

  it("turns chat actions into searchable palette rows that run the action", async () => {
    const run = vi.fn();
    const [item] = buildChatCommandPaletteItems({
      actions: [
        {
          id: "settle",
          title: "Settle chat",
          searchTerms: ["settle", "done"],
          shortcutCommand: "thread.settle",
          run,
        },
      ],
      icon: null,
    });

    expect(item).toMatchObject({
      value: "chat:settle",
      title: "Settle chat",
      shortcutCommand: "thread.settle",
      searchTerms: ["Settle chat", "chat", "settle", "done"],
    });
    const filtered = filterCommandPaletteGroups({
      groups: [{ value: "chat", label: "This chat", items: item ? [item] : [] }],
      query: "done",
    });
    expect(filtered[0]?.items.map((entry) => entry.value)).toEqual(["chat:settle"]);
    await item?.run();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
