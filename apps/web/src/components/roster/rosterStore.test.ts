import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { reorderVisibleRosterBots, useRosterStore } from "./rosterStore";
import type { Bot, Group } from "./types";

function bot(id: string, archivedAt: string | null = null): Bot {
  return {
    id,
    name: id,
    title: "Assistant",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
    engine: null,
    sandbox: null,
    runtimeMode: "full-access",
    usageCap: null,
    voiceEnabled: false,
    groupId: null,
    pinned: false,
    archivedAt,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function group(id: string): Group {
  return {
    id,
    name: id,
    bossBotId: null,
    members: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

const initialState = useRosterStore.getState();

beforeEach(() => {
  useRosterStore.setState({
    bots: [],
    groups: [],
    lastMessageByBotId: {},
    selectedBotId: null,
    chatPathByBotId: {},
    sections: [],
    pinnedItems: [],
    environmentId: null,
  });
});

afterEach(() => {
  useRosterStore.setState({
    bots: initialState.bots,
    groups: initialState.groups,
    lastMessageByBotId: initialState.lastMessageByBotId,
    selectedBotId: initialState.selectedBotId,
    chatPathByBotId: initialState.chatPathByBotId,
    sections: initialState.sections,
    pinnedItems: initialState.pinnedItems,
    environmentId: initialState.environmentId,
  });
  if (typeof window !== "undefined") {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith("akeru:roster:v1")) window.localStorage.removeItem(key);
    }
  }
});

describe("bot selection", () => {
  it("selects the first available bot when a roster arrives without the active bot", () => {
    useRosterStore.setState({ selectedBotId: "missing" });
    useRosterStore.getState().replaceRoster({
      environmentId: "env-one",
      bots: [bot("archived", "2026-08-20T00:00:00.000Z"), bot("akeru")],
      groups: [],
    });

    expect(useRosterStore.getState().selectedBotId).toBe("akeru");
  });

  it("updates a bot's roster preview after a local message", () => {
    const message = { text: "Ship it", at: "2026-08-20T00:00:00.000Z" };

    useRosterStore.getState().recordLastMessage("akeru", message);

    expect(useRosterStore.getState().lastMessageByBotId.akeru).toEqual(message);
  });

  it("keeps each bot's remembered thread path", () => {
    useRosterStore.getState().recordChatPath("akeru", "/env-1/thread-1");
    useRosterStore.getState().recordChatPath("mori", "/draft/draft-2");

    expect(useRosterStore.getState().chatPathByBotId).toEqual({
      akeru: "/env-1/thread-1",
      mori: "/draft/draft-2",
    });

    useRosterStore.getState().forgetChatPath("akeru");
    expect(useRosterStore.getState().chatPathByBotId).toEqual({
      mori: "/draft/draft-2",
    });
  });
});

describe("bot order", () => {
  it("moves a bot downward instead of leaving it in place", () => {
    const bots = [bot("one"), bot("two"), bot("three")];

    const reordered = reorderVisibleRosterBots(bots, ["one", "two", "three"], 0, 2);

    expect(reordered?.map((entry) => entry.id)).toEqual(["two", "three", "one"]);
  });

  it("moves a bot upward", () => {
    const bots = [bot("one"), bot("two"), bot("three")];

    const reordered = reorderVisibleRosterBots(bots, ["one", "two", "three"], 2, 0);

    expect(reordered?.map((entry) => entry.id)).toEqual(["three", "one", "two"]);
  });

  it("keeps filtered bots in place", () => {
    const bots = [bot("one"), bot("hidden"), bot("two"), bot("three")];

    const reordered = reorderVisibleRosterBots(bots, ["one", "two", "three"], 2, 0);

    expect(reordered?.map((entry) => entry.id)).toEqual(["three", "hidden", "one", "two"]);
  });
});

describe("roster sections and pins", () => {
  it("moves a bot into a section without changing group or bot identity", () => {
    const bots = [bot("one"), bot("two")];
    useRosterStore.setState({
      bots,
      sections: [{ id: "news", name: "News", botIds: [], collapsed: false }],
    });

    useRosterStore.getState().moveBotToSection("one", "news");

    expect(useRosterStore.getState().sections[0]?.botIds).toEqual(["one"]);
    expect(useRosterStore.getState().bots).toEqual(bots);
  });

  it("moves a bot between sections and back to unassigned", () => {
    useRosterStore.setState({
      bots: [bot("one")],
      sections: [
        { id: "first", name: "First", botIds: ["one"], collapsed: false },
        { id: "second", name: "Second", botIds: [], collapsed: false },
      ],
    });

    useRosterStore.getState().moveBotToSection("one", "second");
    expect(useRosterStore.getState().sections.map((section) => section.botIds)).toEqual([
      [],
      ["one"],
    ]);

    useRosterStore.getState().moveBotToSection("one", null);
    expect(useRosterStore.getState().sections.map((section) => section.botIds)).toEqual([[], []]);
  });

  it("reorders bots inside Unassigned", () => {
    useRosterStore.setState({ bots: [bot("one"), bot("two"), bot("three")] });

    useRosterStore.getState().moveBotToSection("three", null, 0);

    expect(useRosterStore.getState().bots.map((entry) => entry.id)).toEqual([
      "three",
      "one",
      "two",
    ]);
  });

  it("pins bots and groups as separate quick-launch items", () => {
    useRosterStore.getState().setItemPinned({ kind: "bot", id: "one" }, true);
    useRosterStore.getState().setItemPinned({ kind: "group", id: "crew" }, true);
    useRosterStore.getState().setItemPinned({ kind: "bot", id: "one" }, false);

    expect(useRosterStore.getState().pinnedItems).toEqual([{ kind: "group", id: "crew" }]);
  });

  it("moves a group between a section and Unassigned", () => {
    useRosterStore.setState({
      groups: [group("crew")],
      sections: [
        {
          id: "launch",
          name: "Launch",
          botIds: [],
          groupIds: [],
          collapsed: false,
        },
      ],
    });

    useRosterStore.getState().moveGroupToSection("crew", "launch");
    expect(useRosterStore.getState().sections[0]?.groupIds).toEqual(["crew"]);

    useRosterStore.getState().moveGroupToSection("crew", null);
    expect(useRosterStore.getState().sections[0]?.groupIds).toEqual([]);
  });

  it("reorders sections and persists collapsed state", () => {
    useRosterStore.setState({
      sections: [
        { id: "first", name: "First", botIds: [], collapsed: false },
        { id: "second", name: "Second", botIds: [], collapsed: false },
      ],
    });

    useRosterStore.getState().toggleSection("first");
    useRosterStore.getState().reorderSections(0, 1);

    expect(
      useRosterStore.getState().sections.map(({ id, collapsed }) => ({ id, collapsed })),
    ).toEqual([
      { id: "second", collapsed: false },
      { id: "first", collapsed: true },
    ]);
  });

  it("deletes a section without deleting its bots", () => {
    const bots = [bot("one"), bot("two")];
    useRosterStore.setState({
      bots,
      sections: [{ id: "old", name: "Old", botIds: ["one"], collapsed: false }],
    });

    useRosterStore.getState().deleteSection("old");

    expect(useRosterStore.getState().sections).toEqual([]);
    expect(useRosterStore.getState().bots).toEqual(bots);
  });

  it("does not erase another environment's layout", () => {
    useRosterStore.setState({
      environmentId: "env-one",
      bots: [bot("one")],
      sections: [{ id: "work", name: "Work", botIds: ["one"], collapsed: false }],
    });
    useRosterStore.getState().toggleSection("work");

    useRosterStore.getState().replaceRoster({
      environmentId: "env-two",
      bots: [bot("two")],
      groups: [],
    });
    expect(useRosterStore.getState().sections).toEqual([]);
    useRosterStore.getState().replaceRoster({
      environmentId: "env-one",
      bots: [bot("one")],
      groups: [],
    });

    expect(useRosterStore.getState().sections).toEqual([
      {
        id: "work",
        name: "Work",
        botIds: ["one"],
        groupIds: [],
        collapsed: true,
      },
    ]);
  });
});
