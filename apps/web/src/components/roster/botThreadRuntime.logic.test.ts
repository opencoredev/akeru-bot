import { BotId, GroupId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildBotTurnStartInput,
  buildGroupTurnStartInput,
  createBotTurnSubmissionQueue,
  findLatestBotThreadTarget,
  findLatestGroupThreadTarget,
  findUnhandledMcpAuthorization,
  joinOrStartThreadCreate,
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
      ]),
    ).toEqual({ environmentId: "env-a", threadId: "thread-new" });
  });
});
