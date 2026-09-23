import { describe, expect, it } from "vite-plus/test";

import {
  buildBotActionItems,
  buildRootGroups,
  filterCommandPaletteGroups,
  type CommandPaletteActionItem,
} from "./CommandPalette.logic";

function actionItem(value: string, title: string, searchTerms: string[]): CommandPaletteActionItem {
  return {
    kind: "action",
    value,
    searchTerms,
    title,
    icon: null,
    run: async () => undefined,
  };
}

describe("buildBotActionItems", () => {
  it("opens the bot's conversation and searches its title and label", async () => {
    const opened: string[] = [];
    const items = buildBotActionItems({
      bots: [{ id: "bot-1", name: "Scout", title: "Researcher", label: "research" }],
      icon: () => null,
      searchTerms: (bot) => [bot.title, bot.label],
      openBot: async (bot) => {
        opened.push(bot.id);
      },
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.value).toBe("bot:bot-1");
    expect(items[0]?.title).toBe("Scout");
    expect(items[0]?.searchTerms).toEqual(["Scout", "Researcher", "research"]);

    await items[0]?.run();
    expect(opened).toEqual(["bot-1"]);
  });

  it("omits a description rather than rendering an empty subtitle row", () => {
    const [item] = buildBotActionItems({
      bots: [{ id: "bot-1", name: "Scout" }],
      icon: () => null,
      renderDescription: () => null,
      openBot: async () => undefined,
    });

    expect(item && "description" in item).toBe(false);
  });
});

describe("command palette resting order", () => {
  it("puts bots and conversations ahead of the command list", () => {
    const groups = buildRootGroups({
      botItems: [actionItem("bot:bot-1", "Scout", ["Scout"])],
      recentThreadItems: [actionItem("thread:one", "Yesterday's chat", ["Yesterday's chat"])],
      actionItems: [actionItem("action:settings", "Open settings", ["settings"])],
    });

    expect(groups.map((group) => group.value)).toEqual(["bots", "recent-threads", "actions"]);
  });

  it("drops the bots group entirely when the roster is empty", () => {
    const groups = buildRootGroups({
      botItems: [],
      recentThreadItems: [],
      actionItems: [actionItem("action:settings", "Open settings", ["settings"])],
    });

    expect(groups.map((group) => group.value)).toEqual(["actions"]);
  });
});

describe("command palette search order", () => {
  it("ranks a matching bot above a command that shares the query word", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [
        { value: "bots", label: "Bots", items: [actionItem("bot:bot-1", "Scout", ["Scout"])] },
        {
          value: "actions",
          label: "Actions",
          items: [actionItem("action:scout", "Scout project contents", ["scout", "search"])],
        },
      ],
      query: "scout",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups.map((group) => group.value)).toEqual(["bots", "actions"]);
  });

  it("keeps conversation and project matches ahead of the command list", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [
        {
          value: "actions",
          label: "Actions",
          items: [actionItem("action:add-project", "Add project", ["project"])],
        },
      ],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [actionItem("project:one", "Project one", ["Project one"])],
      threadSearchItems: [actionItem("thread:one", "Project kickoff", ["Project kickoff"])],
    });

    expect(groups.map((group) => group.value)).toEqual([
      "threads-search",
      "projects-search",
      "actions",
    ]);
  });

  it("still narrows to commands only for the > prefix", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [
        { value: "bots", label: "Bots", items: [actionItem("bot:bot-1", "Scout", ["Scout"])] },
        {
          value: "actions",
          label: "Actions",
          items: [actionItem("action:settings", "Open settings", ["settings"])],
        },
      ],
      query: ">settings",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups.map((group) => group.value)).toEqual(["actions"]);
  });
});
