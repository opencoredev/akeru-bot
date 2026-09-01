import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { reorderVisibleRosterBots, useRosterStore } from "./rosterStore";
import type { Bot } from "./types";

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

const initialState = useRosterStore.getState();

beforeEach(() => {
  useRosterStore.setState({
    bots: [],
    groups: [],
    lastMessageByBotId: {},
    selectedBotId: null,
    chatPathByBotId: {},
  });
});

afterEach(() => {
  useRosterStore.setState({
    bots: initialState.bots,
    groups: initialState.groups,
    lastMessageByBotId: initialState.lastMessageByBotId,
    selectedBotId: initialState.selectedBotId,
    chatPathByBotId: initialState.chatPathByBotId,
  });
  if (typeof window !== "undefined") {
    window.localStorage.removeItem("akeru:roster:v1");
  }
});

describe("bot selection", () => {
  it("selects the first available bot when a roster arrives without the active bot", () => {
    useRosterStore.setState({ selectedBotId: "missing" });
    useRosterStore.getState().replaceRoster({
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
