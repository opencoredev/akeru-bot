import {
  ApprovalRequestId,
  BotId,
  CommandId,
  GroupId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationBot,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

const NOW = "2026-09-01T03:40:00.000Z";
const THREAD_ID = ThreadId.make("thread-user-input");
const REQUEST_ID = ApprovalRequestId.make("request-color");
const BOT_ID = BotId.make("bot-akeru");
const GROUP_ID = GroupId.make("group-product");

const archivedBot: OrchestrationBot = {
  id: BOT_ID,
  name: "Akeru",
  title: "Agent",
  label: null,
  description: null,
  disabledMcpServerIds: [],
  avatar: { kind: "dither", seed: BOT_ID },
  engine: null,
  imageProvider: null,
  sandbox: "local",
  runtimeMode: "full-access",
  usageCap: null,
  voiceEnabled: true,
  channelBindings: [],
  groupId: null,
  archivedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
};

function makeThread(): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    botId: null,
    groupId: null,
    respondingBotId: null,
    title: "Question thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: TurnId.make("turn-1"),
      lastError: null,
      updatedAt: NOW,
    },
  };
}

function makeReadModel(): OrchestrationReadModel {
  return {
    ...createEmptyReadModel(NOW),
    threads: [makeThread()],
  };
}

it.layer(NodeServices.layer)("user input response decider", (it) => {
  it.effect("appends the selected answer before resuming the provider", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.user-input.respond",
          commandId: CommandId.make("command-answer-color"),
          threadId: THREAD_ID,
          requestId: REQUEST_ID,
          answers: { color: "Red" },
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.user-input-response-requested",
      ]);
      expect(events[0]).toMatchObject({
        type: "thread.message-sent",
        payload: {
          messageId: MessageId.make(`user-input:${THREAD_ID}:${REQUEST_ID}`),
          role: "user",
          text: "Red",
          turnId: TurnId.make("turn-1"),
        },
      });
      expect(events[1]).toMatchObject({
        type: "thread.user-input-response-requested",
        causationEventId: events[0]?.eventId,
        payload: { answers: { color: "Red" } },
      });
    }),
  );

  for (const type of ["thread.approval.respond", "thread.user-input.respond"] as const) {
    for (const groupChat of [false, true]) {
      it.effect(`rejects ${type} for an archived ${groupChat ? "group boss" : "bot"}`, () =>
        Effect.gen(function* () {
          const readModel = makeReadModel();
          const command =
            type === "thread.approval.respond"
              ? {
                  type,
                  commandId: CommandId.make("command-approval"),
                  threadId: THREAD_ID,
                  requestId: REQUEST_ID,
                  decision: "accept" as const,
                  createdAt: NOW,
                }
              : {
                  type,
                  commandId: CommandId.make("command-answer"),
                  threadId: THREAD_ID,
                  requestId: REQUEST_ID,
                  answers: { color: "Red" },
                  createdAt: NOW,
                };
          const error = yield* decideOrchestrationCommand({
            command,
            readModel: {
              ...readModel,
              bots: [archivedBot],
              groups: groupChat
                ? [
                    {
                      id: GROUP_ID,
                      name: "Product",
                      bossBotId: BOT_ID,
                      members: [{ kind: "bot" as const, botId: BOT_ID, role: "boss" as const }],
                      createdAt: NOW,
                      updatedAt: NOW,
                    },
                  ]
                : [],
              threads: [
                {
                  ...makeThread(),
                  botId: groupChat ? null : BOT_ID,
                  groupId: groupChat ? GROUP_ID : null,
                },
              ],
            },
          }).pipe(Effect.flip);
          expect(String(error)).toContain("is archived");
        }),
      );
    }
  }
});
