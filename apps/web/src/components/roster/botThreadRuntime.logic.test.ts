import {
  BotId,
  GroupId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  acceptBotTurnSubmission,
  buildBotTurnStartInput,
  buildGroupTurnStartInput,
  findLatestBotThreadTarget,
  findLatestGroupThreadTarget,
  joinOrStartThreadCreate,
  releaseBotTurnSubmissionAfterObservation,
  reserveBotTurnSubmission,
} from "./botThreadRuntime.logic";

describe("bot thread runtime", () => {
  it("shares the turn submission lock across runtime instances", () => {
    const release = reserveBotTurnSubmission("env-a:bot-akeru");
    expect(release).not.toBeNull();
    expect(reserveBotTurnSubmission("env-a:bot-akeru")).toBeNull();
    release?.();
  });

  it("retains a reserved submission until the start command responds", () => {
    const key = "env-a:bot-unaccepted";
    const release = reserveBotTurnSubmission(key);
    expect(release).not.toBeNull();
    expect(
      releaseBotTurnSubmissionAfterObservation(
        key,
        {
          requestMessageId: MessageId.make("message-unrelated"),
          state: "completed",
        },
        [
          {
            kind: "provider.turn.start.failed",
            payload: { requestId: "message-unrelated" },
          },
        ],
      ),
    ).toBe(false);
    expect(reserveBotTurnSubmission(key)).toBeNull();
    release?.();
  });

  it("retains an accepted submission until its exact turn settles", () => {
    const key = "env-a:bot-settlement";
    const requestMessageId = MessageId.make("message-request");
    const release = reserveBotTurnSubmission(key);
    expect(release).not.toBeNull();
    acceptBotTurnSubmission(key, requestMessageId);

    expect(
      releaseBotTurnSubmissionAfterObservation(key, { requestMessageId, state: "running" }, []),
    ).toBe(false);
    expect(reserveBotTurnSubmission(key)).toBeNull();
    expect(
      releaseBotTurnSubmissionAfterObservation(key, { requestMessageId, state: "running" }, [
        {
          kind: "provider.turn.start.failed",
          payload: { requestId: requestMessageId },
        },
      ]),
    ).toBe(false);
    expect(
      releaseBotTurnSubmissionAfterObservation(
        key,
        { requestMessageId: MessageId.make("message-other"), state: "completed" },
        [],
      ),
    ).toBe(false);

    for (const state of ["completed", "interrupted", "error"] as const) {
      expect(releaseBotTurnSubmissionAfterObservation(key, { requestMessageId, state }, [])).toBe(
        true,
      );
      const nextRelease = reserveBotTurnSubmission(key);
      expect(nextRelease).not.toBeNull();
      if (state !== "error") acceptBotTurnSubmission(key, requestMessageId);
      else nextRelease?.();
    }
  });

  it("releases only for the exact provider start failure", () => {
    const key = "env-a:bot-start-failure";
    const requestMessageId = MessageId.make("message-request");
    const release = reserveBotTurnSubmission(key);
    expect(release).not.toBeNull();
    acceptBotTurnSubmission(key, requestMessageId);

    expect(
      releaseBotTurnSubmissionAfterObservation(key, null, [
        {
          kind: "provider.turn.start.failed",
          payload: { requestId: "message-other" },
        },
        { kind: "provider.turn.start.failed", payload: null },
        { kind: "provider.turn.start.failed", payload: { requestId: 42 } },
      ]),
    ).toBe(false);
    expect(reserveBotTurnSubmission(key)).toBeNull();
    expect(
      releaseBotTurnSubmissionAfterObservation(key, null, [
        {
          kind: "provider.turn.start.failed",
          payload: { requestId: "message-request" },
        },
      ]),
    ).toBe(true);
  });

  it("does not let stale cleanup release a newer submission", () => {
    const key = "env-a:bot-replaced";
    const staleRelease = reserveBotTurnSubmission(key);
    expect(staleRelease).not.toBeNull();
    staleRelease?.();

    const nextRelease = reserveBotTurnSubmission(key);
    expect(nextRelease).not.toBeNull();
    staleRelease?.();
    expect(reserveBotTurnSubmission(key)).toBeNull();
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
