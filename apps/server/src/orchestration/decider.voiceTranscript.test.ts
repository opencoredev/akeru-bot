import {
  BotId,
  CommandId,
  GroupId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
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
const THREAD_ID = ThreadId.make("thread-voice");
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
    imageProvider: null,
    voiceEnabled: true,
    channelBindings: [],
    groupId: null,
    archivedAt,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeThread(group = false): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    botId: group ? null : BOT_ID,
    groupId: group ? GROUP_ID : null,
    respondingBotId: null,
    title: "Voice thread",
    modelSelection: { instanceId: ProviderInstanceId.make("default"), model: "default-model" },
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
    session: null,
  };
}

function makeReadModel(options?: {
  readonly archived?: boolean;
  readonly group?: boolean;
}): OrchestrationReadModel {
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
    threads: [makeThread(options?.group)],
  };
}

const appendCommand = (overrides?: {
  readonly threadId?: ThreadId;
  readonly role?: "user" | "assistant";
}) => ({
  type: "thread.voice-transcript.append" as const,
  commandId: CommandId.make("cmd-voice-transcript"),
  threadId: overrides?.threadId ?? THREAD_ID,
  messageId: MessageId.make("message-voice-1"),
  role: overrides?.role ?? ("assistant" as const),
  text: "I will start on that now.",
  respondingBotId: BOT_ID,
  createdAt: NOW,
});

it.layer(NodeServices.layer)("voice transcript decider", (it) => {
  it.effect("appends a transcript message without starting a turn", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: appendCommand(),
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "thread.message-sent",
        payload: {
          threadId: THREAD_ID,
          role: "assistant",
          text: "I will start on that now.",
          turnId: null,
          respondingBotId: BOT_ID,
          streaming: false,
        },
      });
    }),
  );

  it.effect("rejects a transcript for an unknown thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: appendCommand({ threadId: ThreadId.make("thread-missing") }),
        readModel: makeReadModel(),
      }).pipe(Effect.flip);
      expect(String(error)).toContain("thread-missing");
    }),
  );

  it.effect("rejects new speech addressed to an archived bot", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: appendCommand({ role: "user" }),
        readModel: makeReadModel({ archived: true }),
      }).pipe(Effect.flip);
      expect(String(error)).toContain("is archived");
    }),
  );

  it.effect("rejects user speech without a bot id, as the web client sends it", () =>
    Effect.gen(function* () {
      const { respondingBotId: _omitted, ...command } = appendCommand({ role: "user" });
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel({ archived: true }),
      }).pipe(Effect.flip);
      expect(String(error)).toContain("is archived");
    }),
  );

  it.effect("rejects a different responder in a direct bot chat", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          ...appendCommand({ role: "user" }),
          respondingBotId: BotId.make("bot-other"),
        },
        readModel: makeReadModel({ archived: true }),
      }).pipe(Effect.flip);
      expect(String(error)).toContain("cannot address a different bot");
    }),
  );

  it.effect("rejects user speech in a group chat whose boss was archived", () =>
    Effect.gen(function* () {
      const { respondingBotId: _omitted, ...command } = appendCommand({ role: "user" });
      const error = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel({ archived: true, group: true }),
      }).pipe(Effect.flip);
      expect(String(error)).toContain(`is archived and cannot respond for group '${GROUP_ID}'`);
    }),
  );

  it.effect("accepts user speech without a bot id for an active bot", () =>
    Effect.gen(function* () {
      const { respondingBotId: _omitted, ...command } = appendCommand({ role: "user" });
      const decided = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.message-sent");
    }),
  );

  it.effect("keeps the tail of a reply that was in flight when the bot was archived", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: appendCommand({ role: "assistant" }),
        readModel: makeReadModel({ archived: true }),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.message-sent");
    }),
  );
});
