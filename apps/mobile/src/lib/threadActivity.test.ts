import { describe, expect, it } from "vite-plus/test";
import { codexFeedbackMessage } from "@akeru/client-runtime/state/threads";
import { BotId, EventId, MessageId, ProjectId, ThreadId, TurnId } from "@akeru/contracts";
import {
  buildThreadFeed,
  createThreadFeedBuilder,
  deriveThreadFeedPresentation,
  threadFeedEntriesEqual,
  unchangedPrefixLength,
} from "./threadActivity";
import { makeActivity, makeThread } from "./threadActivity.test-support";

describe("buildThreadFeed", () => {
  it("tags channel-originated assistant replies with the delivery provider", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-channel-delivery"),
      projectId: ProjectId.make("project-1"),
      title: "Channel thread",
      messages: [
        {
          id: MessageId.make("user-plain"),
          role: "user",
          text: "Local message",
          turnId: null,
          streaming: false,
          createdAt: "2026-09-25T12:00:00.000Z",
          updatedAt: "2026-09-25T12:00:00.000Z",
        },
        {
          id: MessageId.make("assistant-plain"),
          role: "assistant",
          text: "Local reply",
          turnId: null,
          streaming: false,
          createdAt: "2026-09-25T12:00:01.000Z",
          updatedAt: "2026-09-25T12:00:01.000Z",
        },
        {
          id: MessageId.make("user-telegram"),
          role: "user",
          text: "Telegram message",
          turnId: null,
          channelOrigin: { provider: "telegram", externalThreadId: "chat-1" },
          streaming: false,
          createdAt: "2026-09-25T12:00:02.000Z",
          updatedAt: "2026-09-25T12:00:02.000Z",
        },
        {
          id: MessageId.make("assistant-telegram"),
          role: "assistant",
          text: "Telegram reply",
          turnId: null,
          channelDelivery: "sent",
          streaming: false,
          createdAt: "2026-09-25T12:00:03.000Z",
          updatedAt: "2026-09-25T12:00:03.000Z",
        },
      ],
    });

    const feed = buildThreadFeed(thread);
    const byId = new Map(
      feed.flatMap((entry) => (entry.type === "message" ? [[entry.id, entry]] : [])),
    );
    expect(byId.get("assistant-plain")).not.toHaveProperty("channelProvider");
    expect(byId.get("assistant-telegram")).toEqual(
      expect.objectContaining({ channelProvider: "telegram" }),
    );
    expect(byId.get("assistant-telegram")?.message.channelDelivery).toBe("sent");
  });

  it("attaches bot step usage to its assistant message without a duplicate work row", () => {
    const turnId = TurnId.make("turn-bot");
    const thread = makeThread({
      id: ThreadId.make("thread-bot"),
      projectId: ProjectId.make("project-1"),
      title: "Bot thread",
      messages: [
        {
          id: MessageId.make("assistant-bot"),
          role: "assistant",
          text: "Done",
          turnId,
          streaming: false,
          createdAt: "2026-08-31T00:00:02.000Z",
          updatedAt: "2026-08-31T00:00:02.000Z",
        },
      ],
      activities: [
        makeActivity({
          id: EventId.make("usage"),
          kind: "bot.step-usage.updated",
          summary: "Usage",
          turnId,
          createdAt: "2026-08-31T00:00:01.000Z",
          payload: {
            botId: "bot-1",
            engine: { provider: "codex", model: "gpt-5.6-sol" },
            tokens: 1_200,
            estimatedCost: { status: "available", usd: 0.42 },
          },
        }),
      ],
    });

    expect(buildThreadFeed(thread)).toEqual([
      expect.objectContaining({
        type: "message",
        id: "assistant-bot",
        botStepMeter: expect.objectContaining({ tokens: 1_200, costUsd: 0.42 }),
      }),
    ]);
  });

  it("keeps the selected feed stable across metadata and unrelated feedback updates", () => {
    const buildFeed = createThreadFeedBuilder();
    const thread = makeThread({
      id: ThreadId.make("thread-feed-memo"),
      projectId: ProjectId.make("project-1"),
      title: "Before",
    });
    const submissions = {
      selected: [],
      other: [],
    };
    const first = buildFeed(thread, { localMessages: submissions.selected });
    const updated = { ...submissions, other: [{ text: "Other chat feedback" }] };
    const renamed = { ...thread, title: "After" };
    expect(buildFeed(renamed, { localMessages: updated.selected })).toBe(first);
    expect(
      buildFeed(
        { ...thread, activities: [...thread.activities] },
        {
          localMessages: updated.selected,
        },
      ),
    ).not.toBe(first);
  });

  it("reuses activity-derived step meters across message deltas and invalidates new activity", () => {
    const turnId = TurnId.make("turn-meter-cache");
    const payload = {
      botId: BotId.make("bot-meter-cache"),
      engine: { provider: "codex", model: "gpt-5.4" },
      tokens: 10,
      estimatedCost: { status: "available", usd: 0.01 },
    };
    const activity = makeActivity({
      id: EventId.make("meter-cache"),
      kind: "bot.step-usage.updated",
      summary: "Step usage",
      createdAt: "2026-08-31T00:00:01.000Z",
      turnId,
      payload,
    });
    const activities = [activity];
    const base = {
      id: ThreadId.make("thread-meter-cache"),
      projectId: ProjectId.make("project-1"),
      title: "Meter cache",
    };
    const message = {
      id: MessageId.make("meter-cache-reply"),
      role: "assistant" as const,
      text: "Working",
      turnId,
      streaming: true,
      createdAt: "2026-08-31T00:00:02.000Z",
      updatedAt: "2026-08-31T00:00:02.000Z",
    };
    const first = buildThreadFeed(makeThread({ ...base, activities, messages: [message] }));
    const delta = { ...message, text: "Working on it" };
    const second = buildThreadFeed(makeThread({ ...base, activities, messages: [delta] }));
    const firstReply = first.find((entry) => entry.type === "message");
    const secondReply = second.find((entry) => entry.type === "message");
    expect(firstReply?.botStepMeter).toBeDefined();
    expect(secondReply?.botStepMeter).toBe(firstReply?.botStepMeter);

    const updated = { ...activity, payload: { ...payload, tokens: 20 } };
    const third = buildThreadFeed(
      makeThread({ ...base, activities: [updated], messages: [delta] }),
    );
    expect(third.find((entry) => entry.type === "message")?.botStepMeter).not.toBe(
      secondReply?.botStepMeter,
    );
  });

  it("keeps unchanged rows referentially stable while a turn streams", () => {
    const turnId = TurnId.make("turn-stream");
    const user = {
      id: MessageId.make("user-stream"),
      role: "user" as const,
      text: "Run the tests",
      turnId: null,
      streaming: false,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    };
    const toolUpdated = makeActivity({
      id: EventId.make("stream-tool-updated"),
      kind: "tool.updated",
      tone: "tool",
      summary: "Run tests",
      createdAt: "2026-08-31T00:00:01.000Z",
      turnId,
      payload: { title: "Run tests", itemType: "command_execution", detail: "bun run test" },
    });
    const assistant = {
      id: MessageId.make("assistant-stream"),
      role: "assistant" as const,
      text: "Work",
      turnId,
      streaming: true,
      createdAt: "2026-08-31T00:00:02.000Z",
      updatedAt: "2026-08-31T00:00:02.000Z",
    };
    const base = {
      id: ThreadId.make("thread-stream"),
      projectId: ProjectId.make("project-1"),
      title: "Streaming",
    };
    const first = buildThreadFeed(
      makeThread({ ...base, messages: [user, assistant], activities: [toolUpdated] }),
    );
    const grown = { ...assistant, text: "Working", updatedAt: "2026-08-31T00:00:03.000Z" };
    const second = buildThreadFeed(
      makeThread({ ...base, messages: [user, grown], activities: [toolUpdated] }),
    );

    expect(second.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id));
    expect(second[0]).toBe(first[0]);
    const firstGroup = first[1];
    const secondGroup = second[1];
    expect(firstGroup?.type).toBe("activity-group");
    if (firstGroup?.type !== "activity-group" || secondGroup?.type !== "activity-group") return;
    expect(secondGroup.activities[0]).toBe(firstGroup.activities[0]);
    expect(second[2]).not.toBe(first[2]);
    expect(second[2]).toMatchObject({ type: "message", message: { text: "Working" } });

    // Presentation rebuilds wrapper rows; list equality still sees only the streamed row change.
    const presentFirst = deriveThreadFeedPresentation(first, null, new Set());
    const presentSecond = deriveThreadFeedPresentation(second, null, new Set());
    expect(presentSecond[1]).not.toBe(presentFirst[1]);
    expect(
      presentSecond.map((entry, index) => threadFeedEntriesEqual(presentFirst[index]!, entry)),
    ).toEqual([true, true, false]);

    // A lifecycle row merged from a new activity gets a fresh presentation.
    const toolCompleted = makeActivity({
      ...toolUpdated,
      id: EventId.make("stream-tool-completed"),
      kind: "tool.completed",
      summary: "Run tests completed",
      createdAt: "2026-08-31T00:00:01.500Z",
    });
    const third = buildThreadFeed(
      makeThread({ ...base, messages: [user, grown], activities: [toolUpdated, toolCompleted] }),
    );
    const thirdGroup = third[1];
    if (thirdGroup?.type !== "activity-group") throw new Error("expected activity group");
    expect(thirdGroup.activities).toHaveLength(1);
    expect(thirdGroup.activities[0]).not.toBe(firstGroup.activities[0]);
    expect(thirdGroup.activities[0]?.id).toBe("stream-tool-completed");
    expect(threadFeedEntriesEqual(secondGroup, thirdGroup)).toBe(false);
  });

  it("keeps older local feedback before newer messages returned by the server", () => {
    const submission = {
      id: MessageId.make("feedback-command-ordering"),
      command: "/feedback The agent stopped early.",
      createdAt: "2026-08-23T00:00:01.000Z",
      status: "sent" as const,
      feedbackId: "codex-thread-1",
    };
    const laterMessage = {
      id: MessageId.make("later-server-message"),
      role: "assistant" as const,
      text: "Newer server response",
      turnId: null,
      createdAt: "2026-08-23T00:00:02.000Z",
      updatedAt: "2026-08-23T00:00:02.000Z",
      streaming: false,
    };
    const thread = makeThread({
      id: ThreadId.make("thread-feedback-ordering"),
      projectId: ProjectId.make("project-1"),
      title: "Feedback ordering",
      messages: [laterMessage],
    });

    const feed = buildThreadFeed(thread, {
      localMessages: [
        codexFeedbackMessage(submission),
        codexFeedbackMessage(submission, "assistant"),
      ],
    });

    expect(feed.map((entry) => entry.id)).toEqual([
      "feedback-command-ordering",
      "feedback-command-ordering:feedback",
      "later-server-message",
    ]);
  });

  it("keeps historic work entries attributed to their turns", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Runtime warning thread",
      latestTurn: {
        turnId: TurnId.make("turn-latest"),
        state: "running",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("activity-old"),
          kind: "runtime.warning",
          summary: "Runtime warning",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: TurnId.make("turn-old"),
          payload: {
            message: "Old warning",
          },
        }),
        makeActivity({
          id: EventId.make("activity-latest"),
          kind: "runtime.warning",
          summary: "Runtime warning",
          createdAt: "2026-04-01T00:00:03.000Z",
          turnId: TurnId.make("turn-latest"),
          payload: {
            message: "Latest warning",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    expect(feed).toMatchObject([
      {
        type: "activity-group",
        turnId: "turn-old",
        activities: [{ id: "activity-old", turnId: "turn-old" }],
      },
      {
        type: "activity-group",
        turnId: "turn-latest",
        activities: [{ id: "activity-latest", turnId: "turn-latest" }],
      },
    ]);
  });

  it("collapses matching tool lifecycle rows like desktop", () => {
    const thread = makeThread({
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-1"),
      title: "Collapsed tools",
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:03.000Z",
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("tool-updated"),
          kind: "tool.updated",
          tone: "tool",
          summary: "Run tests",
          createdAt: "2026-04-01T00:00:01.000Z",
          turnId: TurnId.make("turn-1"),
          payload: {
            title: "Run tests",
            itemType: "command_execution",
            detail: "/bin/zsh -lc 'bun run test'",
          },
        }),
        makeActivity({
          id: EventId.make("tool-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Run tests completed",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId: TurnId.make("turn-1"),
          payload: {
            title: "Run tests",
            itemType: "command_execution",
            detail: "/bin/zsh -lc 'bun run test'",
          },
        }),
      ],
    });

    const feed = buildThreadFeed(thread);
    const group = feed[0];

    expect(group).toMatchObject({
      type: "activity-group",
    });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities).toHaveLength(1);
    expect(group.activities[0]).toMatchObject({
      id: "tool-completed",
      createdAt: "2026-04-01T00:00:02.000Z",
      turnId: "turn-1",
      summary: "Run tests",
      detail: "bun run test",
      canExpand: true,
      icon: "command",
      toolLike: true,
      status: "success",
    });
    expect(group.activities[0]?.getFullDetail()).toBe("/bin/zsh -lc 'bun run test'");
    expect(group.activities[0]?.getCopyText()).toBe(
      "Run tests\nbun run test\n/bin/zsh -lc 'bun run test'",
    );
  });

  it("keeps MCP inputs available to expanded mobile work rows", () => {
    const turnId = TurnId.make("turn-mcp");
    const thread = makeThread({
      id: ThreadId.make("thread-mcp"),
      projectId: ProjectId.make("project-1"),
      title: "Expandable MCP call",
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: "2026-04-01T00:00:00.000Z",
        startedAt: "2026-04-01T00:00:01.000Z",
        completedAt: "2026-04-01T00:00:03.000Z",
        assistantMessageId: null,
      },
      activities: [
        makeActivity({
          id: EventId.make("mcp-completed"),
          kind: "tool.completed",
          tone: "tool",
          summary: "Call repository tool",
          createdAt: "2026-04-01T00:00:02.000Z",
          turnId,
          payload: {
            title: "Call repository tool",
            itemType: "mcp_tool_call",
            detail: "repository.search",
            status: "completed",
            data: {
              item: {
                server: "repository",
                tool: "search",
                arguments: { query: "work log" },
              },
            },
          },
        }),
      ],
    });

    const group = buildThreadFeed(thread)[0];
    expect(group).toMatchObject({ type: "activity-group" });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities[0]?.icon).toBe("wrench");
    expect(group.activities[0]?.getFullDetail()).toContain('"query": "work log"');
    expect(group.activities[0]?.getFullDetail()).toContain("repository.search");
  });

  it("defers large tool output expansion until a work row is opened or copied", () => {
    let serializedToolOutputs = 0;
    const activities = Array.from({ length: 5_000 }, (_, index) =>
      makeActivity({
        id: EventId.make(`large-tool-${index}`),
        kind: "tool.completed",
        tone: "tool",
        summary: `Tool ${index}`,
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, index)).toISOString(),
        payload: {
          title: `Tool ${index}`,
          itemType: "mcp_tool_call",
          status: "completed",
          data: {
            item: {
              toJSON: () => {
                serializedToolOutputs += 1;
                return { output: "x".repeat(32_768) };
              },
            },
          },
        },
      }),
    );
    const thread = makeThread({
      id: ThreadId.make("thread-large-tools"),
      projectId: ProjectId.make("project-1"),
      title: "Large tools",
      activities,
    });

    const feed = buildThreadFeed(thread);
    expect(serializedToolOutputs).toBe(0);

    const group = feed[0];
    expect(group).toMatchObject({ type: "activity-group" });
    if (!group || group.type !== "activity-group") {
      return;
    }

    expect(group.activities).toHaveLength(5_000);
    expect(group.activities[0]?.getFullDetail()).toContain('"output"');
    expect(serializedToolOutputs).toBe(1);
    expect(group.activities[0]?.getCopyText()).toContain('"output"');
    expect(serializedToolOutputs).toBe(1);
  });
});

describe("unchangedPrefixLength", () => {
  it("reports the whole previous length for appends", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    expect(unchangedPrefixLength([], [a])).toBe(0);
    expect(unchangedPrefixLength([a, b], [a, b, c])).toBe(2);
    expect(unchangedPrefixLength([a, b], [a, b])).toBe(2);
  });

  it("stops at the first removed, inserted, or replaced item", () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    expect(unchangedPrefixLength([a, b, c], [a, c])).toBe(1);
    expect(unchangedPrefixLength([a, b], [a, c, b])).toBe(1);
    expect(unchangedPrefixLength([a, b], [{ id: "a" }, b])).toBe(0);
    // Interior replacement by id keeps both endpoints but must still rescan it.
    expect(unchangedPrefixLength([a, b, c], [a, { id: "b" }, c])).toBe(1);
  });
});
