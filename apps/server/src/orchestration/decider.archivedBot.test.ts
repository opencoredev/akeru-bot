import {
  BotId,
  CommandId,
  GroupId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationBot,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const BOT_ID = BotId.make("bot-akeru");
const THREAD_ID = ThreadId.make("thread-direct");
const GROUP_ID = GroupId.make("group-product");

function makeBot(archivedAt: string | null = null): OrchestrationBot {
  return {
    id: BOT_ID,
    name: "Akeru",
    title: "Agent",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "dither", seed: BOT_ID },
    engine: null,
    sandbox: "local",
    runtimeMode: "full-access",
    usageCap: null,
    voiceEnabled: true,
    channelBindings: [],
    groupId: null,
    archivedAt,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface ReadModelOptions {
  readonly archived?: boolean;
  readonly group?: boolean;
  readonly interrupted?: boolean;
}

function makeThread(options?: ReadModelOptions): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    botId: options?.group ? null : BOT_ID,
    groupId: options?.group ? GROUP_ID : null,
    respondingBotId: options?.group ? BOT_ID : null,
    title: "Direct chat",
    modelSelection: { instanceId: ProviderInstanceId.make("default"), model: "default-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: options?.interrupted
      ? {
          turnId: TurnId.make("turn-1"),
          state: "interrupted",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        }
      : null,
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
    session: null,
  };
}

function makeReadModel(options?: ReadModelOptions): OrchestrationReadModel {
  return {
    ...createEmptyReadModel(NOW),
    bots: [makeBot(options?.archived ? NOW : null)],
    groups: options?.group
      ? [
          {
            id: GROUP_ID,
            name: "Product",
            bossBotId: BOT_ID,
            members: [{ kind: "bot", botId: BOT_ID, role: "boss" }],
            createdAt: NOW,
            updatedAt: NOW,
          },
        ]
      : [],
    threads: [makeThread(options)],
  };
}

const turnStart = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("cmd-turn-start"),
  threadId: THREAD_ID,
  message: {
    messageId: MessageId.make("message-1"),
    role: "user" as const,
    text: "Are you there?",
    attachments: [],
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  createdAt: NOW,
};

const turnResume = {
  type: "thread.turn.resume" as const,
  commandId: CommandId.make("cmd-turn-resume"),
  threadId: THREAD_ID,
  createdAt: NOW,
};

it.layer(NodeServices.layer)("archived bot turns", (it) => {
  it.effect("starts a turn for an active bot", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: turnStart,
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toContain("thread.turn-start-requested");
    }),
  );

  it.effect("refuses a turn a stale client sends to an archived bot", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: turnStart,
        readModel: makeReadModel({ archived: true }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(String(error)).toContain("is archived");
    }),
  );

  for (const group of [false, true]) {
    const chat = group ? "group chat" : "direct chat";

    it.effect(`resumes an interrupted ${chat} with an active bot`, () =>
      Effect.gen(function* () {
        const decided = yield* decideOrchestrationCommand({
          command: turnResume,
          readModel: makeReadModel({ group, interrupted: true }),
        });
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events.map((event) => event.type)).toEqual(["thread.turn-resume-requested"]);
      }),
    );

    it.effect(`refuses to resume a ${chat} whose bot was archived`, () =>
      Effect.gen(function* () {
        const error = yield* decideOrchestrationCommand({
          command: turnResume,
          readModel: makeReadModel({ group, interrupted: true, archived: true }),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
        expect(String(error)).toContain(
          group ? `is archived and cannot respond for group '${GROUP_ID}'` : "is archived",
        );
      }),
    );
  }
});
