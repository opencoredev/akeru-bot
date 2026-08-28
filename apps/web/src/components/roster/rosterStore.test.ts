import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { useRosterStore } from "./rosterStore";
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

describe("pin and order", () => {
  it("pins and unpins only on a completed partition move", () => {
    useRosterStore.setState({ bots: [bot("one"), bot("two"), bot("three")] });

    useRosterStore.getState().moveBot("two", null, true);
    expect(useRosterStore.getState().bots.map(({ id, pinned }) => [id, pinned])).toEqual([
      ["two", true],
      ["one", false],
      ["three", false],
    ]);

    useRosterStore.getState().moveBot("two", null, false);
    expect(useRosterStore.getState().bots.map(({ id, pinned }) => [id, pinned])).toEqual([
      ["one", false],
      ["three", false],
      ["two", false],
    ]);
  });

  it("reorders both partitions and supports valid cross-partition drops", () => {
    useRosterStore.setState({
      bots: [
        { ...bot("pin-a"), pinned: true },
        { ...bot("pin-b"), pinned: true },
        bot("plain-a"),
        bot("plain-b"),
      ],
    });

    useRosterStore.getState().moveBot("pin-b", "pin-a", true);
    useRosterStore.getState().moveBot("plain-b", "plain-a", false);
    useRosterStore.getState().moveBot("plain-a", "pin-a", true);
    expect(useRosterStore.getState().bots.map(({ id, pinned }) => [id, pinned])).toEqual([
      ["pin-b", true],
      ["plain-a", true],
      ["pin-a", true],
      ["plain-b", false],
    ]);
  });

  it("ignores an invalid cross-partition target", () => {
    useRosterStore.setState({ bots: [{ ...bot("pinned"), pinned: true }, bot("plain")] });

    useRosterStore.getState().moveBot("pinned", "plain", true);
    expect(useRosterStore.getState().bots.map((entry) => entry.id)).toEqual(["pinned", "plain"]);
  });
});
