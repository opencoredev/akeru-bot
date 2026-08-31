import { BotId, GroupId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildBotTurnStartInput,
  buildGroupTurnStartInput,
  findLatestBotThreadTarget,
  findLatestGroupThreadTarget,
  joinOrStartThreadCreate,
  observeBotTurnSubmission,
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

  it("retains an accepted submission until a newer turn settles", () => {
    vi.useFakeTimers();
    let latestTurn: { turnId: string; state: string } | null = null;
    const release = reserveBotTurnSubmission("env-a:bot-stale", "turn-old");
    expect(release).not.toBeNull();
    observeBotTurnSubmission("env-a:bot-stale", {
      connected: true,
      generation: 1,
      latestTurn,
    });
    scheduleBotTurnSubmissionFallbackRelease(
      {
        key: "env-a:bot-stale",
        release: release as () => void,
      },
      1_000,
    );

    vi.advanceTimersByTime(999);
    expect(reserveBotTurnSubmission("env-a:bot-stale")).toBeNull();
    vi.advanceTimersByTime(1);
    expect(reserveBotTurnSubmission("env-a:bot-stale")).toBeNull();

    latestTurn = { turnId: "turn-old", state: "completed" };
    observeBotTurnSubmission("env-a:bot-stale", {
      connected: true,
      generation: 1,
      latestTurn,
    });
    vi.advanceTimersByTime(1_000);
    expect(reserveBotTurnSubmission("env-a:bot-stale")).toBeNull();

    latestTurn = { turnId: "turn-new", state: "completed" };
    observeBotTurnSubmission("env-a:bot-stale", {
      connected: true,
      generation: 1,
      latestTurn,
    });
    vi.advanceTimersByTime(1_000);
    const nextRelease = reserveBotTurnSubmission("env-a:bot-stale");
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
  });

  it("retains the submission while a newer turn is running", () => {
    vi.useFakeTimers();
    let latestTurn = { turnId: "turn-new", state: "running" };
    const release = reserveBotTurnSubmission("env-a:bot-running", "turn-old");
    expect(release).not.toBeNull();
    observeBotTurnSubmission("env-a:bot-running", {
      connected: true,
      generation: 1,
      latestTurn,
    });
    scheduleBotTurnSubmissionFallbackRelease(
      {
        key: "env-a:bot-running",
        release: release as () => void,
      },
      1_000,
    );
    vi.advanceTimersByTime(1_000);
    expect(reserveBotTurnSubmission("env-a:bot-running")).toBeNull();

    latestTurn = { turnId: "turn-new", state: "failed" };
    observeBotTurnSubmission("env-a:bot-running", {
      connected: true,
      generation: 1,
      latestTurn,
    });
    vi.advanceTimersByTime(1_000);
    const nextRelease = reserveBotTurnSubmission("env-a:bot-running");
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
  });

  it("retains a running submission through disconnect and reconnect", () => {
    vi.useFakeTimers();
    let connected = true;
    const release = reserveBotTurnSubmission("env-a:bot-disconnected", "turn-old");
    expect(release).not.toBeNull();
    observeBotTurnSubmission("env-a:bot-disconnected", {
      connected,
      generation: 1,
      latestTurn: { turnId: "turn-new", state: "running" },
    });
    scheduleBotTurnSubmissionFallbackRelease(
      {
        key: "env-a:bot-disconnected",
        release: release as () => void,
      },
      1_000,
    );
    vi.advanceTimersByTime(1_000);
    expect(reserveBotTurnSubmission("env-a:bot-disconnected")).toBeNull();
    connected = false;
    observeBotTurnSubmission("env-a:bot-disconnected", {
      connected,
      generation: 1,
      latestTurn: { turnId: "turn-new", state: "running" },
    });
    vi.advanceTimersByTime(1_000);
    expect(reserveBotTurnSubmission("env-a:bot-disconnected")).toBeNull();

    connected = true;
    observeBotTurnSubmission("env-a:bot-disconnected", {
      connected,
      generation: 2,
      latestTurn: { turnId: "turn-new", state: "running" },
    });
    vi.advanceTimersByTime(1_000);
    expect(reserveBotTurnSubmission("env-a:bot-disconnected")).toBeNull();

    observeBotTurnSubmission("env-a:bot-disconnected", {
      connected,
      generation: 2,
      latestTurn: { turnId: "turn-new", state: "completed" },
    });
    vi.advanceTimersByTime(1_000);
    const nextRelease = reserveBotTurnSubmission("env-a:bot-disconnected");
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
  });

  it("releases an unobserved submission after reconnect", () => {
    vi.useFakeTimers();
    const release = reserveBotTurnSubmission("env-a:bot-reconnected", "turn-old");
    expect(release).not.toBeNull();
    observeBotTurnSubmission("env-a:bot-reconnected", {
      connected: true,
      generation: 1,
      latestTurn: { turnId: "turn-old", state: "completed" },
    });
    scheduleBotTurnSubmissionFallbackRelease(
      { key: "env-a:bot-reconnected", release: release as () => void },
      1_000,
    );

    observeBotTurnSubmission("env-a:bot-reconnected", {
      connected: true,
      generation: 2,
      latestTurn: { turnId: "turn-old", state: "completed" },
    });
    vi.advanceTimersByTime(1_000);

    const nextRelease = reserveBotTurnSubmission("env-a:bot-reconnected");
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
  });

  it("releases an unobserved first submission after reconnect", () => {
    vi.useFakeTimers();
    const release = reserveBotTurnSubmission("env-a:bot-first");
    expect(release).not.toBeNull();
    observeBotTurnSubmission("env-a:bot-first", {
      connected: true,
      generation: 1,
      latestTurn: null,
    });
    scheduleBotTurnSubmissionFallbackRelease(
      { key: "env-a:bot-first", release: release as () => void },
      1_000,
    );

    observeBotTurnSubmission("env-a:bot-first", {
      connected: true,
      generation: 2,
      latestTurn: null,
    });
    vi.advanceTimersByTime(1_000);

    const nextRelease = reserveBotTurnSubmission("env-a:bot-first");
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
  });

  it("releases an unobserved submission after the connected grace window", () => {
    vi.useFakeTimers();
    const release = reserveBotTurnSubmission("env-a:bot-connected-stable", "turn-old");
    expect(release).not.toBeNull();
    observeBotTurnSubmission("env-a:bot-connected-stable", {
      connected: true,
      generation: 1,
      latestTurn: { turnId: "turn-old", state: "completed" },
    });
    scheduleBotTurnSubmissionFallbackRelease(
      { key: "env-a:bot-connected-stable", release: release as () => void },
      1_000,
      2,
    );

    vi.advanceTimersByTime(1_000);
    expect(reserveBotTurnSubmission("env-a:bot-connected-stable")).toBeNull();
    vi.advanceTimersByTime(1_000);
    const nextRelease = reserveBotTurnSubmission("env-a:bot-connected-stable");
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
  });

  it("releases an unobserved submission after the disconnected grace window", () => {
    vi.useFakeTimers();
    const release = reserveBotTurnSubmission("env-a:bot-disconnected-stable", "turn-old");
    expect(release).not.toBeNull();
    observeBotTurnSubmission("env-a:bot-disconnected-stable", {
      connected: false,
      generation: 1,
      latestTurn: { turnId: "turn-old", state: "completed" },
    });
    scheduleBotTurnSubmissionFallbackRelease(
      { key: "env-a:bot-disconnected-stable", release: release as () => void },
      1_000,
      2,
    );

    vi.advanceTimersByTime(1_000);
    expect(reserveBotTurnSubmission("env-a:bot-disconnected-stable")).toBeNull();
    vi.advanceTimersByTime(1_000);
    const nextRelease = reserveBotTurnSubmission("env-a:bot-disconnected-stable");
    expect(nextRelease).not.toBeNull();
    nextRelease?.();
  });

  it("does not let stale fallback cleanup release a newer submission", () => {
    vi.useFakeTimers();
    const release = reserveBotTurnSubmission("env-a:bot-replaced", "turn-old");
    expect(release).not.toBeNull();
    observeBotTurnSubmission("env-a:bot-replaced", {
      connected: true,
      generation: 1,
      latestTurn: { turnId: "turn-old", state: "completed" },
    });
    scheduleBotTurnSubmissionFallbackRelease(
      {
        key: "env-a:bot-replaced",
        release: release as () => void,
      },
      1_000,
    );
    release?.();

    const nextRelease = reserveBotTurnSubmission("env-a:bot-replaced");
    expect(nextRelease).not.toBeNull();
    observeBotTurnSubmission("env-a:bot-replaced", {
      connected: false,
      generation: 2,
      latestTurn: null,
    });
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
