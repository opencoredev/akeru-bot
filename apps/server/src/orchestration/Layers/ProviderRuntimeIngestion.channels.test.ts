import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import {
  ApprovalRequestId,
  BotId,
  CommandId,
  DelegationId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as ChannelRuntime from "../../channels/ChannelRuntime.ts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  asProjectId,
  asTurnId,
  asEventId,
  asThreadId,
  asMessageId,
  asItemId,
  createRuntimeIngestionHarness,
} from "./test-support/RuntimeIngestionHarness.ts";

describe("ProviderRuntimeIngestion", () => {
  const testScope = createRuntimeIngestionHarness();
  const { createHarness } = testScope;
  afterEach(testScope.dispose);
  it.each(["slack", "discord"] as const)(
    "shows a waiting reaction while approvals and user input are pending: %s",
    async (provider) => {
      const harness = await createHarness({ botOwned: true });
      const signals = new Set<string>();
      const adds: string[] = [];
      const channel = await harness.connectChannel(async () => {}, provider, {
        add: async (_thread, _message, emoji) => {
          signals.add(emoji);
          adds.push(emoji);
        },
        remove: async (_thread, _message, emoji) => {
          signals.delete(emoji);
        },
      });
      const message = {
        externalThreadId: `${provider}:waiting`,
        externalMessageId: "request-waiting",
        text: "Deploy it",
      };
      await channel.inbound(message);
      const threadId = ChannelRuntime.channelThreadId(
        BotId.make("bot-akeru"),
        asProjectId("project-1"),
        provider,
        message.externalThreadId,
      );
      const turnId = asTurnId("waiting-turn");
      const base = {
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:02.000Z",
      };
      harness.emit({
        ...base,
        turnId,
        eventId: asEventId("waiting-started"),
        type: "turn.started",
        payload: {},
      });
      await harness.drain();
      // The approval carries no turn id; it belongs to the active turn.
      harness.emit({
        ...base,
        eventId: asEventId("waiting-approval"),
        type: "request.opened",
        requestId: ApprovalRequestId.make("waiting-approval"),
        payload: { requestType: "command_execution_approval", detail: "deploy" },
      });
      harness.emit({
        ...base,
        turnId,
        eventId: asEventId("waiting-question"),
        type: "user-input.requested",
        requestId: ApprovalRequestId.make("waiting-question"),
        payload: {
          questions: [
            {
              id: "env",
              header: "Env",
              question: "Which environment?",
              options: [{ label: "prod", description: "Production" }],
            },
          ],
        },
      });
      await harness.drain();
      expect([...signals]).toEqual(["hourglass"]);
      // A resolution without a request id answers one request, not the pending question too.
      harness.emit({
        ...base,
        eventId: asEventId("waiting-approval-resolved"),
        type: "request.resolved",
        payload: { requestType: "command_execution_approval", decision: "accept" },
      });
      await harness.drain();
      expect([...signals]).toEqual(["hourglass"]);
      harness.emit({
        ...base,
        turnId,
        eventId: asEventId("waiting-question-resolved"),
        type: "user-input.resolved",
        requestId: ApprovalRequestId.make("waiting-question"),
        payload: { answers: { env: "prod" } },
      });
      await harness.drain();
      expect([...signals]).toEqual(["eyes"]);
      harness.emit({
        ...base,
        turnId,
        eventId: asEventId("waiting-completed"),
        type: "turn.completed",
        payload: { state: "completed" },
      });
      await harness.drain();
      expect([...signals]).toEqual(["check"]);
      expect(adds).toEqual(["eyes", "hourglass", "eyes", "check"]);
      await harness.disconnectChannel(BotId.make("bot-akeru"), provider);
    },
  );

  it.each(["error", "stopped"] as const)(
    "forgets pending channel requests when the session ends: %s",
    async (state) => {
      const harness = await createHarness({ botOwned: true });
      const signals = new Set<string>();
      const channel = await harness.connectChannel(async () => {}, "slack", {
        add: async (_thread, _message, emoji) => {
          signals.add(emoji);
        },
        remove: async (_thread, _message, emoji) => {
          signals.delete(emoji);
        },
      });
      const markWaiting = vi.spyOn(await harness.channels(), "markChannelTurnWaiting");
      const message = {
        externalThreadId: "slack:session-ended",
        externalMessageId: "request-ended",
        text: "Deploy it",
      };
      await channel.inbound(message);
      const threadId = ChannelRuntime.channelThreadId(
        BotId.make("bot-akeru"),
        asProjectId("project-1"),
        "slack",
        message.externalThreadId,
      );
      const turnId = asTurnId("ended-turn");
      const base = {
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:02.000Z",
      };
      harness.emit({
        ...base,
        turnId,
        eventId: asEventId("ended-started"),
        type: "turn.started",
        payload: {},
      });
      harness.emit({
        ...base,
        turnId,
        eventId: asEventId("ended-approval"),
        type: "request.opened",
        requestId: ApprovalRequestId.make("ended-approval"),
        payload: { requestType: "command_execution_approval", detail: "deploy" },
      });
      await harness.drain();
      expect([...signals]).toEqual(["hourglass"]);
      harness.emit({
        ...base,
        turnId,
        eventId: asEventId("ended-session"),
        type: "session.state.changed",
        payload: { state },
      });
      await harness.drain();
      expect([...signals]).toEqual(["x"]);
      markWaiting.mockClear();
      // A late resolution no longer matches a pending request, so nothing is resumed.
      harness.emit({
        ...base,
        eventId: asEventId("ended-approval-resolved"),
        type: "request.resolved",
        requestId: ApprovalRequestId.make("ended-approval"),
        payload: { requestType: "command_execution_approval", decision: "accept" },
      });
      await harness.drain();
      expect(markWaiting).not.toHaveBeenCalled();
      expect([...signals]).toEqual(["x"]);
      markWaiting.mockRestore();
      await harness.disconnectChannel(BotId.make("bot-akeru"), "slack");
    },
  );

  it.each([
    ["completed", "completed"],
    ["failed", "completed"],
    ["cancelled", "completed"],
    ["completed", "failed"],
    ["completed", "cancelled"],
  ] as const)(
    "replies once only for a completed owner: child %s, owner %s",
    async (childState, ownerState) => {
      const harness = await createHarness({ botOwned: true });
      const posts: Array<{ target: string; text: string }> = [];
      await harness.connectChannel(async (target, text) => {
        posts.push({ target, text });
      });
      const createdAt = "2026-01-01T00:00:01.000Z";
      const ownerThreadId = asThreadId("thread-1");
      const childThreadId = asThreadId("delegated-child");
      const ownerTurnId = asTurnId("owner-turn");
      const childTurnId = asTurnId("child-turn");
      await harness.dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-child-bot"),
        botId: BotId.make("bot-child"),
        name: "Child",
        title: "Research bot",
        avatar: { kind: "dither", seed: "child" },
        engine: { provider: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        sandbox: null,
        runtimeMode: "approval-required",
        usageCap: null,
        groupId: null,
        createdAt,
      });
      await harness.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-child-create"),
        threadId: childThreadId,
        projectId: asProjectId("project-1"),
        botId: BotId.make("bot-child"),
        title: "Delegated work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      await harness.dispatch({
        type: "delegation.create",
        commandId: CommandId.make("cmd-delegation-create"),
        delegation: {
          delegationId: DelegationId.make("channel-delegation"),
          parentDelegationId: null,
          parentBotId: BotId.make("bot-akeru"),
          childBotId: BotId.make("bot-child"),
          parentThreadId: ownerThreadId,
          parentTurnId: ownerTurnId,
          ancestorBotIds: [BotId.make("bot-akeru")],
          depth: 1,
          task: "Research the answer",
          expectedResult: "A concise answer",
          deadline: null,
          access: {
            allowedToolIds: ["Read"],
            memoryScopes: [],
            sandbox: "local",
            runtimeMode: "approval-required",
            hasUserComputer: false,
            enabledMcpServerIds: [],
            disabledMcpServerIds: [],
            approvalCeiling: "send",
          },
          phase: { _tag: "Queued" as const },
          billedBotId: BotId.make("bot-child"),
          keep: false,
          anchorMessageId: null,
          retryOfDelegationId: null,
          trigger: "bot" as const,
          createdAt,
          updatedAt: createdAt,
        },
      });
      for (const [threadId, turnId, text] of [
        [ownerThreadId, ownerTurnId, "Owner answer"],
        [childThreadId, childTurnId, "Child answer"],
      ] as const) {
        await harness.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`request-${turnId}`),
          threadId,
          message: {
            messageId: asMessageId(`request-${turnId}`),
            role: "user",
            text: "Research",
            attachments: [],
            ...(threadId === ownerThreadId
              ? {
                  channelOrigin: {
                    provider: "telegram" as const,
                    externalThreadId: "channel-owner",
                  },
                }
              : {}),
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        const base = {
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId,
          createdAt: "2026-01-01T00:00:02.000Z",
        };
        harness.emit({
          ...base,
          type: "turn.started",
          eventId: asEventId(`start-${turnId}`),
          payload: {},
        });
        harness.emit({
          ...base,
          type: "content.delta",
          eventId: asEventId(`delta-${turnId}`),
          itemId: asItemId(`item-${turnId}`),
          payload: { streamKind: "assistant_text", delta: text },
        });
        harness.emit({
          ...base,
          type: "item.completed",
          eventId: asEventId(`item-${turnId}`),
          itemId: asItemId(`item-${turnId}`),
          payload: { itemType: "assistant_message", status: "completed" },
        });
        await harness.drain();
      }
      const complete = (
        threadId: ThreadId,
        turnId: TurnId,
        state: "completed" | "failed" | "cancelled",
        suffix: string,
      ) => {
        harness.emit({
          type: "turn.completed",
          eventId: asEventId(`complete-${suffix}`),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId,
          createdAt: "2026-01-01T00:00:03.000Z",
          payload: { state },
        });
      };
      complete(childThreadId, childTurnId, childState, "child");
      await harness.drain();
      expect(posts).toEqual([]);
      const child = (await harness.readModel()).threads.find(
        (thread) => thread.id === childThreadId,
      );
      expect(child?.latestTurn?.state).toBe(childState === "failed" ? "error" : "completed");
      complete(ownerThreadId, ownerTurnId, ownerState, "owner");
      await harness.drain();
      expect(
        (await harness.readModel()).threads.find((thread) => thread.id === ownerThreadId)
          ?.latestTurn,
      ).toMatchObject({
        turnId: ownerTurnId,
        state: ownerState === "failed" ? "error" : "completed",
        requestMessageId: asMessageId("request-owner-turn"),
        assistantMessageId: asMessageId("assistant:item-owner-turn"),
      });
      const expectedPosts =
        ownerState === "completed" ? [{ target: "channel-owner", text: "Owner answer" }] : [];
      expect(posts).toEqual(expectedPosts);
      complete(childThreadId, childTurnId, childState, "child-replay");
      complete(ownerThreadId, ownerTurnId, ownerState, "owner-replay");
      await harness.drain();
      expect(posts).toEqual(expectedPosts);
      expect(
        (await harness.readModel()).bots.find((bot) => bot.id === "bot-akeru")?.channelBindings[0]
          ?.sentMessageIds,
      ).toEqual(ownerState === "completed" ? [asMessageId("assistant:item-owner-turn")] : []);
    },
  );
});
