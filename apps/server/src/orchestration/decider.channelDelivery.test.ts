import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import type { OrchestrationProjectorDecodeError } from "./Errors.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-channel-delivery");
const MESSAGE_ID = MessageId.make("message-channel-delivery");

const baseCommand = {
  type: "thread.channel-delivery.set" as const,
  commandId: CommandId.make("cmd-channel-delivery"),
  threadId: THREAD_ID,
  messageId: MESSAGE_ID,
  delivery: "unknown" as const,
  createdAt: NOW,
};

const makeReadModel = (
  messages: ReadonlyArray<{
    role: "user" | "assistant";
    channelDelivery?: "pending" | "sent" | "failed" | "unknown";
  }>,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> =>
  Effect.gen(function* () {
    let model = createEmptyReadModel(NOW);
    model = yield* projectEvent(model, {
      sequence: 1,
      eventId: EventId.make("evt-project-create"),
      aggregateKind: "project",
      aggregateId: ProjectId.make("project-delivery"),
      type: "project.created",
      occurredAt: NOW,
      commandId: CommandId.make("cmd-project-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: ProjectId.make("project-delivery"),
        title: "Project Delivery",
        workspaceRoot: "/tmp/project-delivery",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    model = yield* projectEvent(model, {
      sequence: 2,
      eventId: EventId.make("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: THREAD_ID,
      type: "thread.created",
      occurredAt: NOW,
      commandId: CommandId.make("cmd-thread-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-thread-create"),
      metadata: {},
      payload: {
        threadId: THREAD_ID,
        projectId: ProjectId.make("project-delivery"),
        title: "Thread Delivery",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    for (const [index, message] of messages.entries()) {
      model = yield* projectEvent(model, {
        sequence: 3 + index,
        eventId: EventId.make(`evt-message-${index}`),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        type: "thread.message-sent",
        occurredAt: NOW,
        commandId: CommandId.make(`cmd-message-${index}`),
        causationEventId: null,
        correlationId: CommandId.make(`cmd-message-${index}`),
        metadata: {},
        payload: {
          threadId: THREAD_ID,
          messageId: MESSAGE_ID,
          role: message.role,
          text: `${message.role} text`,
          turnId: null,
          streaming: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      if (message.channelDelivery !== undefined) {
        model = yield* projectEvent(model, {
          sequence: 3 + messages.length + index,
          eventId: EventId.make(`evt-delivery-${index}`),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          type: "thread.channel-delivery-set",
          occurredAt: NOW,
          commandId: CommandId.make(`cmd-delivery-${index}`),
          causationEventId: null,
          correlationId: CommandId.make(`cmd-delivery-${index}`),
          metadata: {},
          payload: {
            threadId: THREAD_ID,
            messageId: MESSAGE_ID,
            delivery: message.channelDelivery,
            updatedAt: NOW,
          },
        });
      }
    }
    return model;
  });

it.layer(NodeServices.layer)("channel delivery decider", (it) => {
  it.effect("emits when the command model cannot see the message after a restart", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel([]);
      expect(readModel.threads[0]?.messages).toEqual([]);

      const decided = yield* decideOrchestrationCommand({
        command: baseCommand,
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.channel-delivery-set"]);
      expect(events[0]).toMatchObject({
        payload: { messageId: MESSAGE_ID, delivery: "unknown" },
      });
    }),
  );

  it.effect("rejects a user message that is visible in the command model", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel([{ role: "user" }]);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: baseCommand, readModel }),
      );
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        commandType: "thread.channel-delivery.set",
      });
    }),
  );

  it.effect("emits nothing when the message already holds the same delivery state", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel([{ role: "assistant", channelDelivery: "unknown" }]);
      const decided = yield* decideOrchestrationCommand({
        command: baseCommand,
        readModel,
      });
      expect(decided).toEqual([]);
    }),
  );

  it.effect("emits for an assistant message whose delivery differs", () =>
    Effect.gen(function* () {
      const readModel = yield* makeReadModel([{ role: "assistant", channelDelivery: "pending" }]);
      const decided = yield* decideOrchestrationCommand({
        command: baseCommand,
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.channel-delivery-set"]);
    }),
  );
});
