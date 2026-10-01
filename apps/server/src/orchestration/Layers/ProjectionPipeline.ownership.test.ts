import {
  BotId,
  CommandId,
  DelegationId,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { makeProjectionPipelinePrefixedTestLayer } from "./test-support/ProjectionPipelineHarness.ts";

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-parent-links-")))(
  "OrchestrationProjectionPipeline",
  (it) => {
    it.effect("links legacy delegated children to their parent in either projection order", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const parentThreadId = ThreadId.make("thread-parent");
        const record = (delegationId: string, childThreadId: string) => ({
          delegationId: DelegationId.make(delegationId),
          parentDelegationId: null,
          parentBotId: BotId.make("bot-parent"),
          childBotId: BotId.make("bot-child"),
          parentThreadId,
          parentTurnId: TurnId.make("turn-parent"),
          ancestorBotIds: [BotId.make("bot-parent")],
          depth: 1,
          task: "Compare the release options.",
          expectedResult: "A short comparison.",
          deadline: null,
          access: {
            allowedToolIds: [],
            memoryScopes: [],
            sandbox: "local" as const,
            runtimeMode: "approval-required" as const,
            hasUserComputer: false,
            enabledMcpServerIds: [],
            disabledMcpServerIds: [],
            approvalCeiling: "none" as const,
          },
          billedBotId: BotId.make("bot-child"),
          keep: false,
          anchorMessageId: null,
          retryOfDelegationId: null,
          trigger: "bot" as const,
          createdAt: now,
          updatedAt: now,
          phase: {
            _tag: "Running" as const,
            childThreadId: ThreadId.make(childThreadId),
            childTurnId: null,
            startedAt: now,
            progress: null,
          },
        });
        const appendDelegation = (delegationId: string, childThreadId: string) =>
          eventStore
            .append({
              type: "delegation.updated",
              eventId: EventId.make(`evt-${delegationId}`),
              aggregateKind: "delegation",
              aggregateId: DelegationId.make(delegationId),
              occurredAt: now,
              commandId: CommandId.make(`cmd-${delegationId}`),
              causationEventId: null,
              correlationId: CommandId.make(`cmd-${delegationId}`),
              metadata: {},
              payload: { delegation: record(delegationId, childThreadId) },
            })
            .pipe(Effect.flatMap(projectionPipeline.projectEvent));
        // A thread.created event from before parent fields existed.
        const appendLegacyThread = (threadId: string) =>
          eventStore
            .append({
              type: "thread.created",
              eventId: EventId.make(`evt-${threadId}`),
              aggregateKind: "thread",
              aggregateId: ThreadId.make(threadId),
              occurredAt: now,
              commandId: CommandId.make(`cmd-${threadId}`),
              causationEventId: null,
              correlationId: CommandId.make(`cmd-${threadId}`),
              metadata: {},
              payload: {
                threadId: ThreadId.make(threadId),
                projectId: ProjectId.make("project-1"),
                title: "Delegated work",
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
            })
            .pipe(Effect.flatMap(projectionPipeline.projectEvent));

        // Replay order: delegation projected before the child thread.
        yield* appendDelegation("delegation-first", "thread-child-late");
        yield* appendLegacyThread("thread-child-late");
        // Live order: child thread exists before its delegation names it.
        yield* appendLegacyThread("thread-child-early");
        yield* appendDelegation("delegation-second", "thread-child-early");

        const rows = yield* sql<{
          readonly threadId: string;
          readonly parentThreadId: string | null;
          readonly parentDelegationId: string | null;
        }>`
          SELECT
            thread_id AS "threadId",
            parent_thread_id AS "parentThreadId",
            parent_delegation_id AS "parentDelegationId"
          FROM projection_threads
          ORDER BY thread_id
        `;
        assert.deepEqual(rows, [
          {
            threadId: "thread-child-early",
            parentThreadId,
            parentDelegationId: "delegation-second",
          },
          {
            threadId: "thread-child-late",
            parentThreadId,
            parentDelegationId: "delegation-first",
          },
        ]);
      }),
    );
  },
);
