import { describe, expect, it, vi } from "vite-plus/test";
import {
  activeComposerModelPicker,
  registerComposerModelPicker,
} from "../composerModelPickerRegistry";
import { activeChatPaletteActions, registerChatPaletteActions } from "../chatActionsRegistry";
import {
  buildChatCommandPaletteItems,
  buildChatSearchCommandPaletteItems,
  buildLanguageCommandPaletteAction,
  buildModelPickerCommandPaletteAction,
  filterCommandPaletteGroups,
  type CommandPaletteChat,
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

  it("shows an action's description, such as a snooze preset's wake time", () => {
    const [snooze, pin] = buildChatCommandPaletteItems({
      actions: [
        {
          id: "snooze:hour",
          title: "Snooze chat: In 1 hour",
          description: "1:00 PM",
          searchTerms: ["snooze"],
          run: () => undefined,
        },
        { id: "pin", title: "Pin chat", searchTerms: ["pin"], run: () => undefined },
      ],
      icon: null,
    });
    expect(snooze?.description).toBe("1:00 PM");
    expect(pin).not.toHaveProperty("description");
  });
});

describe("buildChatSearchCommandPaletteItems", () => {
  const chat = (
    threadId: string,
    title: string,
    updatedAt: string,
    extra: Partial<CommandPaletteChat> = {},
  ): CommandPaletteChat => ({
    environmentId: "env-a",
    threadId,
    title,
    updatedAt,
    ownerName: "Akeru",
    unavailableIn: null,
    ...extra,
  });
  const chats = [
    chat("trip-old", "Old trip notes", "2026-08-01T00:00:00.000Z"),
    chat("trip", "Trip plan", "2026-08-03T00:00:00.000Z"),
    chat("budget", "Budget", "2026-08-02T00:00:00.000Z"),
    chat("draft", "New chat", "2026-08-04T00:00:00.000Z"),
    chat("remote", "Trip receipts", "2026-08-05T00:00:00.000Z", {
      environmentId: "env-b",
      ownerName: null,
      unavailableIn: "Home server",
    }),
  ];
  const build = (
    query: string,
    matches: Parameters<typeof buildChatSearchCommandPaletteItems>[0]["matches"] = [],
    openChat = vi.fn(async () => undefined),
  ) =>
    buildChatSearchCommandPaletteItems({
      query,
      chats,
      matches,
      untitledLabel: "Untitled chat",
      unavailableLabel: (environment) => `In ${environment}`,
      icon: null,
      openChat,
    });

  it("returns nothing for an empty query or an actions-only query", () => {
    expect(build("  ")).toEqual([]);
    expect(build(">trip")).toEqual([]);
  });

  it("ranks prefix title matches ahead of looser ones, newest first among equals", () => {
    expect(build("trip").map((item) => item.value)).toEqual([
      "chat-search:env-a:trip",
      "chat-search:env-a:trip-old",
      "chat-search:env-b:remote",
    ]);
  });

  it("adds message matches after title matches, once per chat, with the snippet", () => {
    const items = build("trip", [
      { environmentId: "env-a", threadId: "trip", snippet: "trip again" },
      { environmentId: "env-a", threadId: "budget", snippet: "the trip costs" },
      { environmentId: "env-a", threadId: "budget", snippet: "second hit" },
      { environmentId: "env-a", threadId: "unknown", snippet: "not a listed chat" },
    ]);
    expect(items.map((item) => item.value)).toEqual([
      "chat-search:env-a:trip",
      "chat-search:env-a:trip-old",
      "chat-search:env-a:budget",
      "chat-search:env-b:remote",
    ]);
    expect(items[2]?.description).toBe("Akeru · the trip costs");
  });

  it("matches a placeholder-titled chat only by message and shows it as untitled", () => {
    expect(build("new chat")).toEqual([]);
    const [item] = build("hello", [
      { environmentId: "env-a", threadId: "draft", snippet: "hello there" },
    ]);
    expect(item?.title).toBe("Untitled chat");
  });

  it("disables chats in another environment and names it", () => {
    const remote = build("receipts")[0];
    expect(remote?.disabled).toBe(true);
    expect(remote?.description).toBe("In Home server");
  });

  it("opens the chosen chat", async () => {
    const openChat = vi.fn(async () => undefined);
    const item = build("budget", [], openChat)[0];
    await item?.run();
    expect(openChat).toHaveBeenCalledWith(chats[2]);
  });

  it("keeps chats this client can open ahead of newer ones it cannot", () => {
    const remote = Array.from({ length: 8 }, (_, index) =>
      chat(`r${index}`, `Plan ${index}`, `2026-08-1${index}T00:00:00.000Z`, {
        environmentId: "env-b",
        unavailableIn: "Home server",
      }),
    );
    const local = [
      chat("local-title", "Plan local", "2026-08-01T00:00:00.000Z"),
      chat("local-message", "Budget", "2026-08-01T00:00:00.000Z"),
    ];
    const items = buildChatSearchCommandPaletteItems({
      query: "plan",
      chats: [...remote, ...local],
      matches: [{ environmentId: "env-a", threadId: "local-message", snippet: "the plan" }],
      untitledLabel: "Untitled chat",
      unavailableLabel: (environment) => environment,
      icon: null,
      openChat: async () => undefined,
    });
    expect(items).toHaveLength(8);
    expect(items.slice(0, 2).map((item) => [item.value, item.disabled])).toEqual([
      ["chat-search:env-a:local-title", undefined],
      ["chat-search:env-a:local-message", undefined],
    ]);
    expect(items.slice(2).every((item) => item.disabled)).toBe(true);
  });

  it("caps the results", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      chat(`c${index}`, `Chat ${index}`, "2026-08-01T00:00:00.000Z"),
    );
    expect(
      buildChatSearchCommandPaletteItems({
        query: "chat",
        chats: many,
        matches: [],
        untitledLabel: "Untitled chat",
        unavailableLabel: (environment) => environment,
        icon: null,
        openChat: async () => undefined,
      }),
    ).toHaveLength(8);
  });
});
