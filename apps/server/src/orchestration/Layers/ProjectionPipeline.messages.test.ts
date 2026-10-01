import {
  BotId,
  CommandId,
  EventId,
  GroupId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { makeProjectionPipelinePrefixedTestLayer } from "./test-support/ProjectionPipelineHarness.ts";

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-ownership-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("projects channel delivery state onto the persisted message column", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.make("evt-delivery-project"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-delivery"),
          occurredAt: now,
          commandId: CommandId.make("cmd-delivery-project"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-delivery-project"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-delivery"),
            title: "Delivery Project",
            workspaceRoot: "/tmp/project-delivery",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* eventStore.append({
          type: "thread.created",
          eventId: EventId.make("evt-delivery-thread"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-delivery"),
          occurredAt: now,
          commandId: CommandId.make("cmd-delivery-thread"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-delivery-thread"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-delivery"),
            projectId: ProjectId.make("project-delivery"),
            title: "Delivery Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* eventStore.append({
          type: "thread.message-sent",
          eventId: EventId.make("evt-delivery-message"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-delivery"),
          occurredAt: now,
          commandId: CommandId.make("cmd-delivery-message"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-delivery-message"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-delivery"),
            messageId: MessageId.make("message-delivery"),
            role: "assistant",
            text: "Reply",
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* eventStore.append({
          type: "thread.channel-delivery-set",
          eventId: EventId.make("evt-delivery-set"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-delivery"),
          occurredAt: now,
          commandId: CommandId.make("cmd-delivery-set"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-delivery-set"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-delivery"),
            messageId: MessageId.make("message-delivery"),
            delivery: "sent",
            updatedAt: now,
          },
        });

        yield* projectionPipeline.bootstrap;

        const rows = yield* sql<{ readonly channelDelivery: string | null }>`
        SELECT channel_delivery AS "channelDelivery"
        FROM projection_thread_messages
        WHERE message_id = 'message-delivery'
      `;
        assert.deepEqual(rows, [{ channelDelivery: "sent" }]);
      }),
    );
    it.effect("clears the stored responder when a thread loses its group", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const threadId = ThreadId.make("thread-group");

        yield* projectionPipeline.projectEvent(
          yield* eventStore.append({
            type: "thread.created",
            eventId: EventId.make("evt-ownership-created"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: CommandId.make("cmd-ownership-created"),
            causationEventId: null,
            correlationId: CommandId.make("cmd-ownership-created"),
            metadata: {},
            payload: {
              threadId,
              projectId: ProjectId.make("project-1"),
              title: "Group chat",
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5-codex",
              },
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        );
        // Stand in for a group chat whose last turn went to a mentioned bot.
        yield* sql`
          UPDATE projection_threads
          SET group_id = ${GroupId.make("group-1")}, responding_bot_id = ${BotId.make("bot-mori")}
          WHERE thread_id = ${threadId}
        `;

        yield* projectionPipeline.projectEvent(
          yield* eventStore.append({
            type: "thread.ownership-updated",
            eventId: EventId.make("evt-ownership-updated"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: now,
            commandId: CommandId.make("cmd-ownership-updated"),
            causationEventId: null,
            correlationId: CommandId.make("cmd-ownership-updated"),
            metadata: {},
            payload: { threadId, botId: null, groupId: null, updatedAt: now },
          }),
        );

        const rows = yield* sql<{
          readonly botId: string | null;
          readonly groupId: string | null;
          readonly respondingBotId: string | null;
        }>`
          SELECT bot_id AS "botId", group_id AS "groupId", responding_bot_id AS "respondingBotId"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        assert.deepEqual(rows, [{ botId: null, groupId: null, respondingBotId: null }]);
      }),
    );
  },
);
