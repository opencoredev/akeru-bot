import {
  BotId,
  CommandId,
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

function makeBot(): OrchestrationBot {
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
    groupId: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeThread(): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    botId: BOT_ID,
    groupId: null,
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

function makeReadModel(): OrchestrationReadModel {
  return {
    ...createEmptyReadModel(NOW),
    bots: [makeBot()],
    threads: [makeThread()],
  };
}

const appendCommand = (overrides?: { readonly threadId?: ThreadId }) => ({
  type: "thread.voice-transcript.append" as const,
  commandId: CommandId.make("cmd-voice-transcript"),
  threadId: overrides?.threadId ?? THREAD_ID,
  messageId: MessageId.make("message-voice-1"),
  role: "assistant" as const,
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
});
