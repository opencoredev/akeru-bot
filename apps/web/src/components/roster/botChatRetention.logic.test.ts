import { EnvironmentId, ThreadId } from "@akeru/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  listBotChats,
  nextRetainedChat,
  preferRetainedChatTarget,
  resolveBotThreadTarget,
  shouldTitlePlaceholderChat,
} from "./botThreadRuntime.logic";

describe("preferRetainedChatTarget", () => {
  const created = {
    ownerId: "bot-1",
    threadRef: { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("new") },
    linked: false,
  };

  const older = { environmentId: "env-1", threadId: "old" };
  const shell = (id: string) => ({ environmentId: "env-1", id, archivedAt: null });

  it("shows a just-created chat once its shell arrives, even when an older chat updated later", () => {
    expect(preferRetainedChatTarget(created, older, [shell("old"), shell("new")])).toEqual({
      environmentId: "env-1",
      threadId: "new",
    });
  });

  it("keeps the resolved chat before the new shell arrives or once the new chat is linked", () => {
    expect(preferRetainedChatTarget(created, older, [shell("old")])).toBe(older);
    expect(
      preferRetainedChatTarget({ ...created, linked: true }, older, [shell("old"), shell("new")]),
    ).toBe(older);
  });
});

describe("shouldTitlePlaceholderChat", () => {
  it("titles a placeholder chat and leaves renamed chats alone", () => {
    expect(shouldTitlePlaceholderChat("new", "New chat", null)).toBe(true);
    expect(shouldTitlePlaceholderChat("new", "Trip plans", "new")).toBe(false);
    expect(shouldTitlePlaceholderChat("new", undefined, "new")).toBe(true);
    expect(shouldTitlePlaceholderChat("other", undefined, "new")).toBe(false);
  });

  it("keeps the first title when a second send runs before the shell updates", () => {
    expect(shouldTitlePlaceholderChat("new", "New chat", null, "new")).toBe(false);
    expect(shouldTitlePlaceholderChat("new", undefined, "new", "new")).toBe(false);
    expect(shouldTitlePlaceholderChat("new", "New chat", null, "older")).toBe(true);
  });
});

describe("opening an older bot chat", () => {
  const chat = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
    environmentId: "env-a",
    id,
    botId: "bot-ren",
    parentThreadId: null as string | null,
    updatedAt,
    archivedAt: null as string | null,
    ...extra,
  });

  const threads = [
    chat("chat-old", "2026-08-01T00:00:00.000Z"),
    chat("chat-new", "2026-08-03T00:00:00.000Z"),
    chat("chat-mid", "2026-08-02T00:00:00.000Z"),
    chat("chat-archived", "2026-08-04T00:00:00.000Z", { archivedAt: "2026-08-05T00:00:00.000Z" }),
    chat("chat-child", "2026-08-06T00:00:00.000Z", { parentThreadId: "chat-new" }),
    chat("chat-other", "2026-08-07T00:00:00.000Z", { botId: "bot-mira" }),
    chat("chat-elsewhere", "2026-08-08T00:00:00.000Z", { environmentId: "env-b" }),
  ];

  it("lists only the bot's active direct chats, newest first", () => {
    expect(listBotChats("bot-ren", "env-a", threads).map((thread) => thread.id)).toEqual([
      "chat-new",
      "chat-mid",
      "chat-old",
    ]);
  });

  it("shows the opened chat instead of the newest one", () => {
    expect(resolveBotThreadTarget("bot-ren", "env-a", threads, undefined, "chat-old")).toEqual({
      environmentId: "env-a",
      threadId: "chat-old",
    });
  });

  it("falls back to the newest chat when the opened one is not an active chat of the bot", () => {
    for (const openThreadId of ["chat-archived", "chat-child", "chat-other", "missing", null]) {
      expect(
        resolveBotThreadTarget("bot-ren", "env-a", threads, undefined, openThreadId)?.threadId,
      ).toBe("chat-new");
    }
  });
});

describe("nextRetainedChat", () => {
  const chat = (threadId: string) => ({
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make(threadId),
  });

  it("keeps a just-created chat until its shell arrives", () => {
    const created = { ownerId: "bot-1", threadRef: chat("new"), linked: false };
    expect(nextRetainedChat(created, null, true)).toBe(created);
  });

  it("keeps a just-created chat while the list still shows the previous chat", () => {
    const created = { ownerId: "bot-1", threadRef: chat("new"), linked: false };
    expect(nextRetainedChat(created, chat("old"), true)).toBe(created);
    expect(nextRetainedChat(created, chat("new"), true)).toEqual({
      ownerId: "bot-1",
      threadRef: chat("new"),
      linked: true,
    });
  });

  it("releases a just-created chat when another chat is opened on purpose", () => {
    const created = { ownerId: "bot-1", threadRef: chat("new"), linked: false };
    expect(nextRetainedChat(created, chat("older"), true, "older")).toEqual({
      ownerId: "bot-1",
      threadRef: chat("older"),
      linked: true,
    });
    expect(nextRetainedChat(created, chat("old"), true, "new")).toBe(created);
  });

  it("follows the linked chat once the shell list shows it", () => {
    const linked = chat("new");

    const next = nextRetainedChat(
      { ownerId: "bot-1", threadRef: null, linked: false },
      linked,
      true,
    );

    expect(next).toEqual({ ownerId: "bot-1", threadRef: linked, linked: true });
    expect(nextRetainedChat(next, linked, true)).toBe(next);
  });

  it("releases a chat that left the shell list, so the next send starts a new one", () => {
    const shown = { ownerId: "bot-1", threadRef: chat("archived"), linked: true };
    expect(nextRetainedChat(shown, null, true)).toEqual({
      ownerId: "bot-1",
      threadRef: null,
      linked: false,
    });
  });

  it("holds a shown chat while the shell list is still loading", () => {
    const shown = { ownerId: "bot-1", threadRef: chat("current"), linked: true };
    expect(nextRetainedChat(shown, null, false)).toBe(shown);
  });
});
