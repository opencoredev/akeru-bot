import { BotId, GroupId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildBotTurnStartInput,
  buildGroupTurnStartInput,
  findLatestBotThreadTarget,
  findLatestGroupThreadTarget,
  joinOrStartThreadCreate,
  releaseBotTurnSubmissionAfterSettlement,
  reserveBotTurnSubmission,
  scheduleBotTurnSubmissionFallbackRelease,
} from "./botThreadRuntime.logic";

afterEach(() => {
  vi.useRealTimers();
});

describe("bot thread runtime", () => {
  it("shares the turn submission lock across runtime instances", () => {
    const release = reserveBotTurnSubmission("env-a:bot-akeru", "turn-old");
    expect(release).not.toBeNull();
    expect(reserveBotTurnSubmission("env-a:bot-akeru")).toBeNull();
    expect(
      releaseBotTurnSubmissionAfterSettlement("env-a:bot-akeru", {
        turnId: "turn-new",
        state: "running",
      }),
    ).toBe(false);
    expect(
      releaseBotTurnSubmissionAfterSettlement("env-a:bot-akeru", {
        turnId: "turn-new",
        state: "completed",
      }),
    ).toBe(true);
    const nextRelease = reserveBotTurnSubmission("env-a:bot-akeru");
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
    release?.();
  });

  it("releases an accepted submission when no newer turn is observed", () => {
    vi.useFakeTimers();
    const release = reserveBotTurnSubmission("env-a:bot-stale", "turn-old");
    expect(release).not.toBeNull();
    scheduleBotTurnSubmissionFallbackRelease(
      {
        release: release as () => void,
        previousTurnId: "turn-old",
        getLatestTurn: () => ({ turnId: "turn-old", state: "completed" }),
        isConnected: () => true,
      },
      1_000,
    );

    vi.advanceTimersByTime(999);
    expect(reserveBotTurnSubmission("env-a:bot-stale")).toBeNull();
    vi.advanceTimersByTime(1);

    const nextRelease = reserveBotTurnSubmission("env-a:bot-stale");
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
  });

  it("retains the submission while a newer turn is running", () => {
    vi.useFakeTimers();
    let latestTurn = { turnId: "turn-new", state: "running" };
    const release = reserveBotTurnSubmission("env-a:bot-running", "turn-old");
    expect(release).not.toBeNull();
    scheduleBotTurnSubmissionFallbackRelease(
      {
        release: release as () => void,
        previousTurnId: "turn-old",
        getLatestTurn: () => latestTurn,
        isConnected: () => true,
      },
      1_000,
    );

    vi.advanceTimersByTime(1_000);
    expect(reserveBotTurnSubmission("env-a:bot-running")).toBeNull();

    latestTurn = { turnId: "turn-new", state: "failed" };
    vi.advanceTimersByTime(1_000);
    const nextRelease = reserveBotTurnSubmission("env-a:bot-running");
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
  });

  it("releases a running submission after the environment disconnects", () => {
    vi.useFakeTimers();
    let connected = true;
    const release = reserveBotTurnSubmission("env-a:bot-disconnected", "turn-old");
    expect(release).not.toBeNull();
    scheduleBotTurnSubmissionFallbackRelease(
      {
        release: release as () => void,
        previousTurnId: "turn-old",
        getLatestTurn: () => ({ turnId: "turn-new", state: "running" }),
        isConnected: () => connected,
      },
      1_000,
    );

    vi.advanceTimersByTime(1_000);
    expect(reserveBotTurnSubmission("env-a:bot-disconnected")).toBeNull();
    connected = false;
    vi.advanceTimersByTime(1_000);

    const nextRelease = reserveBotTurnSubmission("env-a:bot-disconnected");
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
  });

  it("does not let stale fallback cleanup release a newer submission", () => {
    vi.useFakeTimers();
    const release = reserveBotTurnSubmission("env-a:bot-replaced", "turn-old");
    expect(release).not.toBeNull();
    scheduleBotTurnSubmissionFallbackRelease(
      {
        release: release as () => void,
        previousTurnId: "turn-old",
        getLatestTurn: () => ({ turnId: "turn-old", state: "completed" }),
        isConnected: () => true,
      },
      1_000,
    );
    release?.();

    const nextRelease = reserveBotTurnSubmission("env-a:bot-replaced");
    expect(nextRelease).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(reserveBotTurnSubmission("env-a:bot-replaced")).toBeNull();

    nextRelease?.();
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
