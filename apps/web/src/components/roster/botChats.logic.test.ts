import { describe, expect, it } from "vite-plus/test";

import { buildBotChatRows } from "./botChats.logic";

const chats = Array.from({ length: 10 }, (_, index) => ({
  id: `chat-${index}`,
  title: `Chat ${index}`,
  updatedAt: `2026-08-${String(20 - index).padStart(2, "0")}T00:00:00.000Z`,
}));

describe("buildBotChatRows", () => {
  it("lists the newest chats up to the limit and marks the open one", () => {
    const rows = buildBotChatRows({ chats, currentThreadId: "chat-2", limit: 4 });
    expect(rows.map((row) => row.threadId)).toEqual(["chat-0", "chat-1", "chat-2", "chat-3"]);
    expect(rows.filter((row) => row.current).map((row) => row.threadId)).toEqual(["chat-2"]);
    expect(rows.filter((row) => row.newest).map((row) => row.threadId)).toEqual(["chat-0"]);
  });

  it("keeps an open chat that is older than the listed ones in the last slot", () => {
    const rows = buildBotChatRows({ chats, currentThreadId: "chat-9", limit: 4 });
    expect(rows.map((row) => row.threadId)).toEqual(["chat-0", "chat-1", "chat-2", "chat-9"]);
    expect(rows.at(-1)?.current).toBe(true);
  });

  it("shows placeholder and blank titles as untitled", () => {
    const rows = buildBotChatRows({
      chats: [
        { id: "a", title: "New chat", updatedAt: "2026-08-20T00:00:00.000Z" },
        { id: "b", title: "  ", updatedAt: "2026-08-19T00:00:00.000Z" },
        { id: "c", title: "Trip plan", updatedAt: "2026-08-18T00:00:00.000Z" },
      ],
      currentThreadId: null,
    });
    expect(rows.map((row) => row.title)).toEqual([null, null, "Trip plan"]);
  });

  it("lists eight chats by default", () => {
    expect(buildBotChatRows({ chats, currentThreadId: null })).toHaveLength(8);
  });
});
