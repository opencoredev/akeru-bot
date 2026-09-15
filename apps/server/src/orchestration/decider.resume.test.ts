import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

const NOW = "2026-09-15T12:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-resume");

function makeThread(status: "error" | "ready") {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    botId: null,
    groupId: null,
    respondingBotId: null,
    title: "Interrupted chat",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: status === "error" ? "error" : "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: status === "error" ? NOW : null,
      assistantMessageId: null,
    },
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
      status,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: status === "error" ? "Automatic recovery failed." : null,
      updatedAt: NOW,
    },
  } satisfies OrchestrationThread;
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return { ...createEmptyReadModel(NOW), threads: [thread] };
}

it.layer(NodeServices.layer)("turn resume decider", (it) => {
  it.effect("emits an invisible resume request for an errored turn", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.resume",
          commandId: CommandId.make("command-resume"),
          threadId: THREAD_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel(makeThread("error")),
      });

      expect(event).toMatchObject({
        type: "thread.turn-resume-requested",
        payload: { threadId: THREAD_ID, createdAt: NOW },
      });
    }),
  );

  it.effect("rejects resume when no interrupted turn exists", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.resume",
          commandId: CommandId.make("command-resume-completed"),
          threadId: THREAD_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel(makeThread("ready")),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationCommandInvariantError");
      expect(error.message).toContain("does not have an interrupted request");
    }),
  );

  it.effect("allows retry when the provider rejected the request before creating a turn", () =>
    Effect.gen(function* () {
      const thread = makeThread("error");
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.resume",
          commandId: CommandId.make("command-resume-pre-provider"),
          threadId: THREAD_ID,
          createdAt: NOW,
        },
        readModel: makeReadModel({
          ...thread,
          latestTurn: null,
          messages: [
            {
              id: "message-pre-provider" as never,
              role: "user",
              text: "Retry this exact request.",
              turnId: null,
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      });

      expect(event).toMatchObject({ type: "thread.turn-resume-requested" });
    }),
  );
});
