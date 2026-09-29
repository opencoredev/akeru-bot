import {
  BotId,
  EnvironmentId,
  GroupId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildBotTurnStartInput,
  buildGroupTurnStartInput,
  createBotTurnSubmissionQueue,
  findLatestBotThreadTarget,
  findLatestGroupThreadTarget,
  findUnhandledMcpAuthorization,
  isBotOwnChatShell,
  joinOrStartThreadCreate,
  nextRetainedChat,
  preferRetainedChatTarget,
  resolveBotThreadTarget,
  shouldTitlePlaceholderChat,
  type RetainedChat,
} from "./botThreadRuntime.logic";

describe.each([
  { name: "bot", findLatest: findLatestBotThreadTarget, ownerKey: "botId" as const },
  { name: "group", findLatest: findLatestGroupThreadTarget, ownerKey: "groupId" as const },
])("latest $name thread selection", ({ findLatest, ownerKey }) => {
  const thread = (id: string, updatedAt = "2026-08-27T00:00:00.000Z") => ({
    environmentId: "env-a",
    id,
    botId: "owner",
    groupId: "owner",
    updatedAt,
    archivedAt: null as string | null,
    deletedAt: null as string | null | undefined,
  });

  it("returns null for empty and non-matching inputs", () => {
    expect(findLatest("owner", "env-a", [])).toBeNull();
    expect(
      findLatest("owner", "env-a", [
        { ...thread("wrong-environment"), environmentId: "env-b" },
        { ...thread("wrong-owner"), [ownerKey]: "other" },
        { ...thread("archived"), archivedAt: "2026-08-28T00:00:00.000Z" },
        { ...thread("deleted"), deletedAt: "2026-08-28T00:00:00.000Z" },
      ]),
    ).toBeNull();
  });

  it("preserves descending timestamp and ID order without mutating the input", () => {
    const candidates = [
      thread("z-older", "2026-08-26T00:00:00.000Z"),
      thread("b-newer"),
      thread("a-newer"),
      { ...thread("z-deleted", "2026-08-29T00:00:00.000Z"), deletedAt: "deleted" },
      { ...thread("z-archived", "2026-08-29T00:00:00.000Z"), archivedAt: "archived" },
      { ...thread("z-remote", "2026-08-29T00:00:00.000Z"), environmentId: "env-b" },
      { ...thread("z-other", "2026-08-29T00:00:00.000Z"), [ownerKey]: "other" },
    ];
    for (const input of [candidates, candidates.toReversed()]) {
      const original = [...input];
      expect(findLatest("owner", "env-a", Object.freeze(input))).toEqual({
        environmentId: "env-a",
        threadId: "b-newer",
      });
      expect(input).toEqual(original);
    }
    expect(
      findLatest("owner", "env-a", [{ ...thread("no-deletion-field"), deletedAt: undefined }]),
    ).toEqual({ environmentId: "env-a", threadId: "no-deletion-field" });
  });

  it("keeps the first candidate when timestamp and ID collate equally", () => {
    const composed = thread("é");
    const decomposed = thread("e\u0301");
    expect(composed.id.localeCompare(decomposed.id)).toBe(0);
    for (const candidates of [
      [composed, decomposed],
      [decomposed, composed],
    ]) {
      expect(findLatest("owner", "env-a", candidates)?.threadId).toBe(candidates[0]?.id);
    }
  });

  it("matches filter-sort selection with only 2,046 locale comparisons for 1,024 ties", () => {
    const candidates = Array.from({ length: 1_024 }, (_, index) =>
      thread(`thread-${String((index * 317) % 1_024).padStart(4, "0")}`),
    );
    const compare = vi.spyOn(String.prototype, "localeCompare");
    let oldComparisons = 0;
    let newComparisons = 0;
    try {
      const oldLatest = candidates
        .filter(
          (entry) =>
            entry.environmentId === "env-a" &&
            entry[ownerKey] === "owner" &&
            entry.archivedAt === null &&
            entry.deletedAt == null,
        )
        .toSorted(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
        )[0];
      oldComparisons = compare.mock.calls.length;
      compare.mockClear();
      const latest = findLatest("owner", "env-a", candidates);
      newComparisons = compare.mock.calls.length;
      expect(latest).toEqual({ environmentId: oldLatest?.environmentId, threadId: oldLatest?.id });
      expect(newComparisons).toBe(2 * (candidates.length - 1));
      expect(oldComparisons).toBeGreaterThan(newComparisons);
    } finally {
      compare.mockRestore();
    }
    console.info(`Latest ${ownerKey}: locale comparisons ${oldComparisons} -> ${newComparisons}`);
  });
});

describe("bot thread runtime", () => {
  it("finds each secure MCP authorization once and rejects unsafe URLs", () => {
    const activities = [
      {
        id: "unsafe",
        kind: "mcp.oauth.authorization-required",
        payload: { authorizationUrl: "http://example.com" },
      },
      {
        id: "oauth",
        kind: "mcp.oauth.authorization-required",
        payload: { authorizationUrl: "https://hoplite.example/authorize" },
      },
    ];
    expect(findUnhandledMcpAuthorization(activities, new Set())).toEqual({
      activityId: "oauth",
      url: "https://hoplite.example/authorize",
    });
    expect(findUnhandledMcpAuthorization(activities, new Set(["oauth"]))).toBeNull();
  });
  it("queues rapid submissions without waiting for the active reply", async () => {
    const queue = createBotTurnSubmissionQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
      return true;
    });
    const second = queue.enqueue(async () => {
      order.push("second");
      return true;
    });
    const third = queue.enqueue(async () => {
      order.push("third");
      return true;
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst?.();
    await expect(Promise.all([first, second, third])).resolves.toEqual([true, true, true]);
    expect(order).toEqual(["first:start", "first:end", "second", "third"]);
  });

  it("continues queued submissions after one fails", async () => {
    const queue = createBotTurnSubmissionQueue();
    const failed = queue.enqueue(async () => {
      throw new Error("dispatch failed");
    });
    const followUp = queue.enqueue(async () => "sent");

    await expect(failed).rejects.toThrow("dispatch failed");
    await expect(followUp).resolves.toBe("sent");
  });

  it("shares concurrent initial thread creation", async () => {
    let retained: { threadId: string } | null = null;
    const inFlight = { current: null as Promise<{ threadId: string } | null> | null };
    let starts = 0;
    const start = async () => {
      starts += 1;
      await Promise.resolve();
      retained = { threadId: "thread-akeru" };
      return retained;
    };
    const join = () => joinOrStartThreadCreate({ getRetained: () => retained, inFlight, start });

    const [first, second] = await Promise.all([join(), join()]);
    expect(starts).toBe(1);
    expect(first).toBe(retained);
    expect(second).toBe(retained);

    expect(await join()).toBe(retained);
    expect(starts).toBe(1);
  });

  it("associates the first durable thread with its bot", () => {
    const input = buildBotTurnStartInput({
      botId: BotId.make("bot-akeru"),
      threadId: ThreadId.make("thread-akeru"),
      projectId: ProjectId.make("project-akeru"),
      title: "Hello",
      message: {
        messageId: "message-akeru" as never,
        role: "user",
        text: "Hello",
        attachments: [],
      },
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-08-27T00:00:00.000Z",
      createThread: true,
    });

    expect(input.bootstrap?.createThread?.botId).toBe("bot-akeru");
    expect(input.bootstrap?.createThread?.projectId).toBe("project-akeru");
  });

  it("associates a group thread and routes a mention to its selected bot", () => {
    const input = buildGroupTurnStartInput({
      groupId: GroupId.make("group-product"),
      respondingBotId: BotId.make("bot-specialist"),
      threadId: ThreadId.make("thread-product"),
      projectId: ProjectId.make("project-akeru"),
      title: "Review this",
      message: {
        messageId: "message-product" as never,
        role: "user",
        text: "@Mori Review this",
        attachments: [],
      },
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-08-27T00:00:00.000Z",
      createThread: true,
    });

    expect(input.bootstrap?.createThread?.groupId).toBe("group-product");
    expect(input.respondingBotId).toBe("bot-specialist");
  });

  it("restores the latest durable thread owned by the bot", () => {
    expect(
      findLatestBotThreadTarget("bot-akeru", "env-a", [
        {
          environmentId: "env-a",
          id: "thread-old",
          botId: "bot-akeru",
          updatedAt: "2026-08-26T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
        },
        {
          environmentId: "env-a",
          id: "thread-other",
          botId: "bot-other",
          updatedAt: "2026-08-28T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
        },
        {
          environmentId: "env-a",
          id: "delegated-child",
          botId: "bot-akeru",
          parentThreadId: "parent-thread",
          updatedAt: "2026-08-29T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
        },
        {
          environmentId: "env-b",
          id: "thread-new",
          botId: "bot-akeru",
          updatedAt: "2026-08-27T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
        },
      ]),
    ).toEqual({ environmentId: "env-a", threadId: "thread-old" });
  });

  it("does not target a parent-linked child thread", () => {
    expect(
      findLatestBotThreadTarget("bot-akeru", "env-a", [
        {
          environmentId: "env-a",
          id: "delegated-child",
          botId: "bot-akeru",
          parentThreadId: "parent-thread",
          updatedAt: "2026-08-29T00:00:00.000Z",
          archivedAt: null,
        },
      ]),
    ).toBeNull();
  });

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
      expect(
        isBotOwnChatShell("bot-ren", { botId: "bot-ren", parentThreadId: "thread-mira" }),
      ).toBe(false);
      expect(isBotOwnChatShell("bot-ren", { botId: "bot-mira", parentThreadId: null })).toBe(false);
      expect(isBotOwnChatShell("bot-ren", { botId: "bot-ren", parentThreadId: null })).toBe(true);
    });

    it("still follows a remembered chat the shell list has not caught up to", () => {
      expect(resolveChat([], "/env-a/thread-new")).toBe("thread-new");
    });
  });

  it("restores the latest durable thread owned by a group", () => {
    expect(
      findLatestGroupThreadTarget("group-product", "env-a", [
        {
          environmentId: "env-a",
          id: "thread-old",
          groupId: "group-product",
          updatedAt: "2026-08-26T00:00:00.000Z",
          archivedAt: null,
        },
        {
          environmentId: "env-a",
          id: "thread-new",
          groupId: "group-product",
          updatedAt: "2026-08-27T00:00:00.000Z",
          archivedAt: null,
        },
        {
          environmentId: "env-a",
          id: "delegated-child",
          groupId: "group-product",
          parentThreadId: "parent-thread",
          updatedAt: "2026-08-28T00:00:00.000Z",
          archivedAt: null,
        },
      ]),
    ).toEqual({ environmentId: "env-a", threadId: "thread-new" });
  });

  it("does not target a parent-linked group child thread", () => {
    expect(
      findLatestGroupThreadTarget("group-product", "env-a", [
        {
          environmentId: "env-a",
          id: "delegated-child",
          groupId: "group-product",
          parentThreadId: "parent-thread",
          updatedAt: "2026-08-28T00:00:00.000Z",
          archivedAt: null,
        },
      ]),
    ).toBeNull();
  });
});

describe("preferRetainedChatTarget", () => {
  const created = {
    ownerId: "bot-1",
    threadRef: { environmentId: EnvironmentId.make("env-1"), threadId: ThreadId.make("new") },
    linked: false,
    picked: true,
  };
  const older = { environmentId: "env-1", threadId: "old" };
  const shell = (id: string) => ({ environmentId: "env-1", id, archivedAt: null });

  it("shows a just-created chat once its shell arrives, even when an older chat updated later", () => {
    expect(preferRetainedChatTarget(created, older, [shell("old"), shell("new")])).toEqual({
      environmentId: "env-1",
      threadId: "new",
    });
  });

  it("keeps a picked chat after it is linked while its shell is live", () => {
    const linked = { ...created, linked: true };
    expect(preferRetainedChatTarget(linked, older, [shell("old"), shell("new")])).toEqual({
      environmentId: "env-1",
      threadId: "new",
    });
    expect(
      preferRetainedChatTarget(linked, older, [
        shell("old"),
        { ...shell("new"), archivedAt: "2026-09-01T00:00:00.000Z" },
      ]),
    ).toBe(older);
  });

  it("keeps the resolved chat before the new shell arrives or for a chat the user did not pick", () => {
    expect(preferRetainedChatTarget(created, older, [shell("old")])).toBe(older);
    expect(
      preferRetainedChatTarget({ ...created, linked: true, picked: false }, older, [
        shell("old"),
        shell("new"),
      ]),
    ).toBe(older);
  });

  it("does not snap back to an older chat that replied after the new chat was linked", () => {
    const shells = [shell("old"), shell("new")];
    let retained: RetainedChat = created;
    for (let render = 0; render < 3; render += 1) {
      const target = preferRetainedChatTarget(retained, older, shells);
      expect(target).toEqual({ environmentId: "env-1", threadId: "new" });
      retained = nextRetainedChat(retained, created.threadRef, true);
    }
    expect(retained).toEqual({ ...created, linked: true });
  });
});

describe("shouldTitlePlaceholderChat", () => {
  it("titles a placeholder chat and leaves renamed chats alone", () => {
    expect(shouldTitlePlaceholderChat("new", "New chat", null)).toBe(true);
    expect(shouldTitlePlaceholderChat("new", "Trip plans", "new")).toBe(false);
    expect(shouldTitlePlaceholderChat("new", undefined, "new")).toBe(true);
    expect(shouldTitlePlaceholderChat("other", undefined, "new")).toBe(false);
  });
});

describe("nextRetainedChat", () => {
  const chat = (threadId: string) => ({
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make(threadId),
  });

  it("keeps a just-created chat until its shell arrives", () => {
    const created = { ownerId: "bot-1", threadRef: chat("new"), linked: false, picked: true };
    expect(nextRetainedChat(created, null, true)).toBe(created);
  });

  it("keeps a just-created chat while the list still shows the previous chat", () => {
    const created = { ownerId: "bot-1", threadRef: chat("new"), linked: false, picked: true };
    expect(nextRetainedChat(created, chat("old"), true)).toBe(created);
    expect(nextRetainedChat(created, chat("new"), true)).toEqual({
      ownerId: "bot-1",
      threadRef: chat("new"),
      linked: true,
      picked: true,
    });
  });

  it("follows the linked chat once the shell list shows it", () => {
    const linked = chat("new");
    const next = nextRetainedChat(
      { ownerId: "bot-1", threadRef: null, linked: false, picked: false },
      linked,
      true,
    );
    expect(next).toEqual({ ownerId: "bot-1", threadRef: linked, linked: true, picked: false });
    expect(nextRetainedChat(next, linked, true)).toBe(next);
  });

  it("releases a chat that left the shell list, so the next send starts a new one", () => {
    const shown = { ownerId: "bot-1", threadRef: chat("archived"), linked: true, picked: true };
    expect(nextRetainedChat(shown, null, true)).toEqual({
      ownerId: "bot-1",
      threadRef: null,
      linked: false,
      picked: false,
    });
  });

  it("drops the pick when the list moves to another chat after the picked one left", () => {
    const shown = { ownerId: "bot-1", threadRef: chat("archived"), linked: true, picked: true };
    expect(nextRetainedChat(shown, chat("old"), true)).toEqual({
      ownerId: "bot-1",
      threadRef: chat("old"),
      linked: true,
      picked: false,
    });
  });

  it("holds a shown chat while the shell list is still loading", () => {
    const shown = { ownerId: "bot-1", threadRef: chat("current"), linked: true, picked: false };
    expect(nextRetainedChat(shown, null, false)).toBe(shown);
  });
});
