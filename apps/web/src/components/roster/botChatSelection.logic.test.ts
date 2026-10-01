import { describe, expect, it } from "vite-plus/test";

import {
  isBotOwnChatShell,
  pickBotChatTarget,
  preferRetainedChatTarget,
  resolveBotThreadTarget,
} from "./botThreadRuntime.logic";

describe("bot chat resolution with child work", () => {
  const child = (id: string, updatedAt: string) => ({
    environmentId: "env-a",
    id,
    botId: "bot-ren",
    parentThreadId: "thread-mira",
    updatedAt,
    archivedAt: null,
  });

  const direct = {
    environmentId: "env-a",
    id: "thread-ren",
    botId: "bot-ren",
    parentThreadId: null,
    updatedAt: "2026-08-27T00:00:00.000Z",
    archivedAt: null,
  };

  // Mirrors the roster hooks: the shell list leaves out child work, and the
  // resolved target's own shell (which does include child work) decides.
  const resolveChat = (
    allThreads: ReadonlyArray<typeof direct | ReturnType<typeof child>>,
    rememberedPath?: string,
  ) => {
    const listed = allThreads.filter((thread) => thread.parentThreadId == null);
    const target = resolveBotThreadTarget("bot-ren", "env-a", listed, rememberedPath);

    if (!target) return null;
    const shell = allThreads.find((thread) => thread.id === target.threadId) ?? null;

    return isBotOwnChatShell("bot-ren", shell) ? target.threadId : null;
  };

  it("gives a bot whose only threads are child work no chat, even when remembered", () => {
    const threads = [
      child("child-1", "2026-08-28T00:00:00.000Z"),
      child("child-2", "2026-08-29T00:00:00.000Z"),
    ];

    expect(resolveChat(threads)).toBeNull();
    expect(resolveChat(threads, "/env-a/child-2")).toBeNull();
  });

  it("keeps the direct chat when a newer child thread exists", () => {
    const threads = [direct, child("child-new", "2026-08-29T00:00:00.000Z")];
    expect(resolveChat(threads)).toBe("thread-ren");
    expect(resolveChat(threads, "/env-a/child-new")).toBe("thread-ren");
  });

  it("rejects child work and other owners' threads as a bot's chat", () => {
    expect(isBotOwnChatShell("bot-ren", { botId: "bot-ren", parentThreadId: "thread-mira" })).toBe(
      false,
    );
    expect(isBotOwnChatShell("bot-ren", { botId: "bot-mira", parentThreadId: null })).toBe(false);
    expect(isBotOwnChatShell("bot-ren", { botId: "bot-ren", parentThreadId: null })).toBe(true);
  });

  it("still follows a remembered chat the shell list has not caught up to", () => {
    expect(resolveChat([], "/env-a/thread-new")).toBe("thread-new");
  });
});

describe("picked bot chat", () => {
  const shell = (id: string, updatedAt: string, archivedAt: string | null = null) => ({
    environmentId: "env-a",
    id,
    botId: "bot-ren",
    parentThreadId: null,
    updatedAt,
    archivedAt,
  });

  // Chat A replied after the user picked chat B, so A is the latest.
  const shells = [
    shell("thread-b", "2026-09-01T00:00:00.000Z"),
    shell("thread-a", "2026-09-02T00:00:00.000Z"),
  ];

  it("keeps the remembered chat after a remount even when another chat replied later", () => {
    // A fresh runtime starts with nothing retained, as after a page refresh.
    const empty = { ownerId: "bot-ren", threadRef: null, linked: false };
    const resolved = resolveBotThreadTarget("bot-ren", "env-a", shells, "/env-a/thread-b");
    expect(preferRetainedChatTarget(empty, resolved, shells)).toEqual({
      environmentId: "env-a",
      threadId: "thread-b",
    });
  });

  it("gives the side panel the same chat as the conversation", () => {
    const remembered = { environmentId: "env-a", threadId: "thread-b" };

    // The side panel resolves from the latest id and the remembered chat's own shell.
    const panel = pickBotChatTarget(
      "bot-ren",
      "env-a",
      { environmentId: "env-a", threadId: "thread-a" },
      remembered,
      shells[0],
    );

    expect(panel).toEqual(resolveBotThreadTarget("bot-ren", "env-a", shells, "/env-a/thread-b"));
    expect(panel).toEqual(remembered);
  });

  it("follows the chat opened on purpose", () => {
    expect(resolveBotThreadTarget("bot-ren", "env-a", shells, "/env-a/thread-a")).toEqual({
      environmentId: "env-a",
      threadId: "thread-a",
    });
  });

  it("releases the pick once the remembered chat is archived, deleted, or not the bot's", () => {
    const latest = { environmentId: "env-a", threadId: "thread-a" };
    const remembered = { environmentId: "env-a", threadId: "thread-b" };
    const live = shells[0]!;
    expect(
      pickBotChatTarget("bot-ren", "env-a", latest, remembered, {
        ...live,
        archivedAt: "2026-09-03T00:00:00.000Z",
      }),
    ).toBe(latest);
    expect(
      pickBotChatTarget("bot-ren", "env-a", latest, remembered, {
        ...live,
        deletedAt: "2026-09-03T00:00:00.000Z",
      }),
    ).toBe(latest);
    expect(
      pickBotChatTarget("bot-ren", "env-a", latest, remembered, { ...live, botId: "bot-mira" }),
    ).toBe(latest);
    expect(
      pickBotChatTarget("bot-ren", "env-a", latest, remembered, {
        ...live,
        parentThreadId: "thread-mira",
      }),
    ).toBe(latest);
    expect(pickBotChatTarget("bot-ren", "env-a", latest, remembered, null)).toBe(latest);
    expect(
      resolveBotThreadTarget(
        "bot-ren",
        "env-a",
        [shell("thread-b", "2026-09-01T00:00:00.000Z", "2026-09-03T00:00:00.000Z"), shells[1]!],
        "/env-a/thread-b",
      ),
    ).toEqual(latest);
  });
});
