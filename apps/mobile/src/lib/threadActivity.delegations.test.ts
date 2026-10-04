import { Predicate } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { botChatTimeline } from "@akeru/client-runtime/state/bot-chat-timeline";
import {
  BotId,
  DelegationId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type AkeruDelegationRecord,
  type OrchestrationThread,
} from "@akeru/contracts";
import {
  buildThreadFeed,
  createThreadFeedBuilder,
  deriveGroupSpeakerLabels,
  deriveThreadFeedPresentation,
  threadFeedEntriesEqual,
} from "./threadActivity";
import { makeActivity, makeThread } from "./threadActivity.test-support";

describe("delegation cards in the feed", () => {
  const at = (second: number) => `2026-09-25T10:00:${String(second).padStart(2, "0")}.000Z`;

  const feedDelegation = (
    id: string,
    second: number,
    parentTurnId: string,
    anchorMessageId: string | null,
  ): AkeruDelegationRecord => ({
    delegationId: DelegationId.make(id),
    parentDelegationId: null,
    parentBotId: BotId.make("bot-parent"),
    childBotId: BotId.make("bot-child"),
    parentThreadId: ThreadId.make("thread-parent"),
    parentTurnId: TurnId.make(parentTurnId),
    ancestorBotIds: [BotId.make("bot-parent")],
    depth: 1,
    task: "Compare three flights.",
    expectedResult: "A short comparison.",
    deadline: null,
    access: {
      allowedToolIds: [],
      memoryScopes: [],
      sandbox: null,
      runtimeMode: "approval-required",
      hasUserComputer: false,
      enabledMcpServerIds: [],
      disabledMcpServerIds: [],
      approvalCeiling: "none",
    },
    billedBotId: BotId.make("bot-child"),
    keep: false,
    anchorMessageId: anchorMessageId === null ? null : MessageId.make(anchorMessageId),
    retryOfDelegationId: null,
    trigger: "bot",
    createdAt: at(second),
    updatedAt: at(second),
    phase: { _tag: "Queued" },
  });

  const userMessage = (id: string, second: number) => ({
    id: MessageId.make(id),
    role: "user" as const,
    text: id,
    turnId: null,
    createdAt: at(second),
    updatedAt: at(second),
    streaming: false,
  });

  const assistantMessage = (id: string, second: number, turnId: string) => ({
    id: MessageId.make(id),
    role: "assistant" as const,
    text: id,
    turnId: TurnId.make(turnId),
    createdAt: at(second),
    updatedAt: at(second),
    streaming: false,
  });

  const feedThread = (messages: OrchestrationThread["messages"]) =>
    makeThread({
      id: ThreadId.make("thread-parent"),
      projectId: ProjectId.make("project-1"),
      title: "Parent chat",
      messages,
    });

  const messages = [
    userMessage("user-1", 1),
    assistantMessage("bot-1", 3, "turn-1"),
    userMessage("user-2", 10),
    assistantMessage("bot-2", 12, "turn-2"),
    userMessage("user-3", 20),
    assistantMessage("bot-3", 22, "turn-3"),
  ];

  it("invalidates the cached feed when delegation cards or local messages change", () => {
    const buildFeed = createThreadFeedBuilder();
    const thread = feedThread(messages);
    const delegation = feedDelegation("d-cache", 2, "turn-1", "user-1");
    const initial = buildFeed(thread);
    const carded = buildFeed(thread, { delegations: [delegation] });
    expect(carded).not.toBe(initial);
    expect(carded.some((entry) => entry.type === "delegation")).toBe(true);
    expect(buildFeed(thread, { delegations: [delegation] })).toBe(carded);
    const updated = { ...delegation, task: "Updated task" };
    const changed = buildFeed(thread, { delegations: [updated] });
    expect(changed).not.toBe(carded);
    expect(changed.find((entry) => entry.type === "delegation")?.delegation.task).toBe(
      "Updated task",
    );
    expect(
      buildFeed(thread, {
        delegations: [updated],
        localMessages: [userMessage("local-feedback", 30)],
      }),
    ).not.toBe(changed);
  });

  it("matches botChatTimeline order for three turns", () => {
    const feed = buildThreadFeed(feedThread(messages), {
      delegations: [
        feedDelegation("d-3", 21, "turn-3", "user-3"),
        feedDelegation("d-1", 2, "turn-1", "user-1"),
        feedDelegation("d-2", 11, "turn-2", "user-2"),
      ],
    });

    expect(feed.map((entry) => entry.id)).toEqual([
      "user-1",
      "bot-1",
      "delegation:d-1",
      "user-2",
      "bot-2",
      "delegation:d-2",
      "user-3",
      "bot-3",
      "delegation:d-3",
    ]);
  });

  it("offers try again only on a card no later card retries", () => {
    const canceledPhase = {
      _tag: "Canceled" as const,
      childThreadId: null,
      childTurnId: null,
      startedAt: null,
      completedAt: at(4),
      canceledBy: "user" as const,
    };

    const original = { ...feedDelegation("d-1", 2, "turn-1", "user-1"), phase: canceledPhase };

    const retry = {
      ...feedDelegation("d-2", 11, "turn-2", "user-2"),
      retryOfDelegationId: original.delegationId,
      phase: canceledPhase,
    };

    const before = buildThreadFeed(feedThread(messages), { delegations: [original] });
    const feed = buildThreadFeed(feedThread(messages), { delegations: [original, retry] });
    const oldCard = before.find((entry) => entry.id === "delegation:d-1");
    const updatedCard = feed.find((entry) => entry.id === "delegation:d-1");
    expect(oldCard?.type).toBe("delegation");
    expect(updatedCard?.type).toBe("delegation");

    if (oldCard && updatedCard) {
      expect(threadFeedEntriesEqual(oldCard, updatedCard)).toBe(false);
    }

    const actions = Object.fromEntries(
      feed.flatMap((entry) => (entry.type === "delegation" ? [[entry.id, entry.actions]] : [])),
    );

    expect(actions).toEqual({ "delegation:d-1": [], "delegation:d-2": ["retry"] });
  });

  it("lands the card under its anchor before the turn has a reply", () => {
    const feed = buildThreadFeed(feedThread(messages.slice(0, 3)), {
      delegations: [feedDelegation("d-2", 11, "turn-2", "user-2")],
    });

    expect(feed.map((entry) => entry.id)).toEqual(["user-1", "bot-1", "user-2", "delegation:d-2"]);
  });

  it("keeps a card visible while its settled turn's work log is folded", () => {
    const thread = {
      ...feedThread(messages),
      activities: [
        makeActivity({
          id: EventId.make("turn-1-warning"),
          kind: "runtime.warning",
          summary: "Warning",
          createdAt: at(2),
          turnId: TurnId.make("turn-1"),
        }),
      ],
    };

    const feed = buildThreadFeed(thread, {
      delegations: [feedDelegation("d-1", 2, "turn-1", "user-1")],
    });

    const running = {
      turnId: TurnId.make("turn-3"),
      state: "running" as const,
      startedAt: at(30),
      completedAt: null,
    };

    const collapsed = deriveThreadFeedPresentation(feed, running, new Set()).map(
      (entry) => entry.id,
    );

    // The work log folds; the card does not join it.
    expect(collapsed).toContain("turn-fold:turn-1");
    expect(collapsed).not.toContain("turn-1-warning");
    expect(collapsed).toContain("delegation:d-1");
    expect(collapsed.indexOf("delegation:d-1")).toBeLessThan(collapsed.indexOf("user-2"));

    const expanded = deriveThreadFeedPresentation(
      feed,
      running,
      new Set([TurnId.make("turn-1")]),
    ).map((entry) => entry.id);

    expect(expanded).toContain("turn-1-warning");
    expect(expanded.filter((id) => id === "delegation:d-1")).toHaveLength(1);
  });

  it("drops a delegation activity whose record already has a card", () => {
    const deliveryActivity = (id: string, delegationId: string) =>
      makeActivity({
        id: EventId.make(id),
        kind: "delegation.completed",
        summary: "Finished work",
        createdAt: at(4),
        turnId: TurnId.make("turn-1"),
        payload: { delegationId },
      });

    const thread = {
      ...feedThread(messages.slice(0, 2)),
      activities: [deliveryActivity("carded", "d-1"), deliveryActivity("uncarded", "d-orphan")],
    };

    const ids = buildThreadFeed(thread, {
      delegations: [feedDelegation("d-1", 2, "turn-1", "user-1")],
    }).map((entry) => entry.id);

    expect(ids).toEqual(["user-1", "bot-1", "delegation:d-1", "uncarded"]);
  });

  it("renders each delegation record once", () => {
    const records = [
      feedDelegation("d-1", 2, "turn-1", "user-1"),
      feedDelegation("d-2", 11, "turn-2", "user-2"),
      feedDelegation("d-3", 21, "turn-3", "user-3"),
    ];

    const thread = {
      ...feedThread(messages),
      activities: records.map((record, index) =>
        makeActivity({
          id: EventId.make(`delivery-${index}`),
          kind: "delegation.completed",
          summary: "Finished work",
          createdAt: record.createdAt,
          turnId: record.parentTurnId,
          payload: { delegationId: record.delegationId },
        }),
      ),
    };

    const feed = buildThreadFeed(thread, { delegations: records });

    const presented = deriveThreadFeedPresentation(
      feed,
      { turnId: TurnId.make("turn-3"), state: "running", startedAt: at(30), completedAt: null },
      new Set(),
    );

    for (const entries of [feed, presented]) {
      const cardIds = entries.flatMap((entry) =>
        entry.type === "delegation" ? [entry.delegation.delegationId] : [],
      );

      expect(cardIds).toEqual(["d-1", "d-2", "d-3"]);
      expect(entries.some((entry) => entry.id.startsWith("delivery-"))).toBe(false);
    }
  });

  it("offers actions on running and failed cards", () => {
    const running = {
      ...feedDelegation("d-1", 2, "turn-1", "user-1"),
      phase: {
        _tag: "Running" as const,
        childThreadId: ThreadId.make("child-1"),
        childTurnId: null,
        startedAt: at(3),
        progress: null,
      },
    };

    const failed = {
      ...feedDelegation("d-2", 11, "turn-2", "user-2"),
      phase: {
        _tag: "Failed" as const,
        childThreadId: null,
        childTurnId: null,
        startedAt: at(12),
        completedAt: at(13),
        failure: { failureCode: "child_failed" as const, message: "Child crashed." },
        acknowledgedAt: null,
      },
    };

    const feed = buildThreadFeed(feedThread(messages), { delegations: [running, failed] });

    const actions = Object.fromEntries(
      feed.flatMap((entry) => (entry.type === "delegation" ? [[entry.id, entry.actions]] : [])),
    );

    expect(actions["delegation:d-1"]).toEqual(expect.arrayContaining(["keep", "cancel"]));
    expect(actions["delegation:d-2"]).toEqual(["retry"]);
  });

  it("keeps cards when a work-log group holds several activities (P1-2 regression)", () => {
    // Four warnings between bot-1 and user-2 collapse into ONE activity-group
    // row. The merge must still land both cards in the right place instead of
    // counting the group's activities against the grouped index space.
    const thread = {
      ...feedThread(messages.slice(0, 4)),
      activities: [4, 5, 6, 7].map((second, index) =>
        makeActivity({
          id: EventId.make(`warn-${index}`),
          kind: "runtime.warning",
          summary: `Warning ${index}`,
          createdAt: at(second),
          turnId: TurnId.make("turn-1"),
        }),
      ),
    };

    const feed = buildThreadFeed(thread, {
      delegations: [
        feedDelegation("d-1", 2, "turn-1", "user-1"),
        feedDelegation("d-2", 11, "turn-2", "user-2"),
      ],
    });

    expect(feed.map((entry) => entry.id)).toEqual([
      "user-1",
      "bot-1",
      "delegation:d-1",
      "warn-0",
      "user-2",
      "bot-2",
      "delegation:d-2",
    ]);
  });

  it("places every card after the same message as botChatTimeline (ordering parity)", () => {
    // Spec LEO-608: web renders botChatTimeline rows directly; mobile re-maps
    // them onto feed rows. One fixture with a multi-activity group and a
    // dropped empty message exercises both index-space hazards.
    const parityMessages = [
      userMessage("user-1", 1),
      assistantMessage("bot-1", 3, "turn-1"),
      userMessage("user-2", 10),
      // An empty assistant row the grouping pass drops: cards anchored on it
      // slide back to the nearest rendered message, like web's anchor fallback.
      { ...assistantMessage("bot-2-empty", 11, "turn-2"), text: "" },
      assistantMessage("bot-2", 12, "turn-2"),
      userMessage("user-3", 20),
      assistantMessage("bot-3", 22, "turn-3"),
    ];

    const thread = {
      ...feedThread(parityMessages),
      activities: [4, 5, 6].map((second, index) =>
        makeActivity({
          id: EventId.make(`parity-warn-${index}`),
          kind: "runtime.warning",
          summary: `Warning ${index}`,
          createdAt: at(second),
          turnId: TurnId.make("turn-1"),
        }),
      ),
    };

    const delegations = [
      feedDelegation("d-1", 2, "turn-1", "user-1"),
      feedDelegation("d-2", 13, "turn-2", "user-2"),
      feedDelegation("d-3", 21, "turn-3", "user-3"),
    ];

    const timeline = botChatTimeline({
      messages: parityMessages.map((message) => ({
        id: message.id,
        turnId: message.turnId,
        createdAt: message.createdAt,
      })),
      delegations,
    });

    const feed = buildThreadFeed(thread, { delegations });
    const feedIds = feed.map((entry) => entry.id);
    const feedIdSet = new Set(feedIds);
    // The message rows in feed order, so "next rendered message" is O(1).
    const feedMessageIds = feed.flatMap((entry) => (entry.type === "message" ? [entry.id] : []));

    let previousMessageId: string | null = null;

    for (const entry of timeline) {
      if (Predicate.isTagged(entry, "Message")) {
        if (feedIdSet.has(entry.message.id)) {
          previousMessageId = entry.message.id;
        }

        continue;
      }

      if (!Predicate.isTagged(entry, "Delegation")) continue;
      const cardId = `delegation:${entry.delegation.delegationId}`;
      expect(feedIds).toContain(cardId);
      const cardIndex = feedIds.indexOf(cardId);

      if (previousMessageId !== null) {
        expect(cardIndex).toBeGreaterThan(feedIds.indexOf(previousMessageId));
      }

      // The card must appear before the next message row that survived
      // grouping — no message may leap ahead of its turn's card.
      const nextMessageId = feedMessageIds.find(
        (id) =>
          previousMessageId !== null &&
          feedIds.indexOf(id) > feedIds.indexOf(previousMessageId) &&
          id !== previousMessageId,
      );

      if (nextMessageId !== undefined) {
        expect(cardIndex).toBeLessThan(feedIds.indexOf(nextMessageId));
      }

      previousMessageId = null;
    }
  });
});

describe("deriveGroupSpeakerLabels", () => {
  const at = (second: number) => `2026-09-25T11:00:${String(second).padStart(2, "0")}.000Z`;
  const mira = BotId.make("bot-mira");
  const ren = BotId.make("bot-ren");

  const message = (
    id: string,
    second: number,
    role: "user" | "assistant",
    respondingBotId: BotId | null = null,
    text = id,
  ) => ({
    id: MessageId.make(id),
    role,
    text,
    turnId: role === "assistant" ? TurnId.make(`turn-${id}`) : null,
    respondingBotId,
    createdAt: at(second),
    updatedAt: at(second),
    streaming: false,
  });

  const feedOf = (messages: OrchestrationThread["messages"]) =>
    buildThreadFeed(
      makeThread({
        id: ThreadId.make("thread-group"),
        projectId: ProjectId.make("project-1"),
        title: "Mira and Ren",
        messages,
      }),
    );

  it("labels assistant messages where the speaker changes, falling back to the boss", () => {
    const feed = feedOf([
      message("user-1", 1, "user"),
      message("boss-1", 2, "assistant"),
      message("mira-2", 3, "assistant", mira),
      message("user-2", 4, "user"),
      message("mira-3", 5, "assistant", mira),
      message("ren-1", 6, "assistant", ren),
      message("empty", 7, "assistant", mira, "  "),
      message("ren-2", 8, "assistant", ren),
    ]);

    expect(Object.fromEntries(deriveGroupSpeakerLabels(feed, { bossBotId: mira }))).toEqual({
      "boss-1": mira,
      "ren-1": ren,
    });
  });

  it("labels nothing outside a group chat", () => {
    const feed = feedOf([message("mira-1", 1, "assistant", mira)]);
    expect(deriveGroupSpeakerLabels(feed, null).size).toBe(0);
  });

  it("labels named replies in a group without a boss", () => {
    const feed = feedOf([
      message("user-1", 1, "user"),
      message("unnamed", 2, "assistant"),
      message("mira-1", 3, "assistant", mira),
      message("ren-1", 4, "assistant", ren),
    ]);

    expect(Object.fromEntries(deriveGroupSpeakerLabels(feed, { bossBotId: null }))).toEqual({
      "mira-1": mira,
      "ren-1": ren,
    });
  });
});
