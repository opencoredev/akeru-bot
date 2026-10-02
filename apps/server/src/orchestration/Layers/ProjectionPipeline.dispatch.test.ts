import {
  CommandId,
  CorrelationId,
  EventId,
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
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  engineLayer,
  makeProjectionPipelinePrefixedTestLayer,
} from "./test-support/ProjectionPipelineHarness.ts";

engineLayer("OrchestrationProjectionPipeline via engine dispatch", (it) => {
  it.effect("projects dispatched engine events immediately", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-live-project"),
        projectId: ProjectId.make("project-live"),
        title: "Live Project",
        workspaceRoot: "/tmp/project-live",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      const projectRows = yield* sql<{ readonly title: string; readonly scriptsJson: string }>`
        SELECT
          title,
          scripts_json AS "scriptsJson"
        FROM projection_projects
        WHERE project_id = 'project-live'
      `;

      assert.deepEqual(projectRows, [{ title: "Live Project", scriptsJson: "[]" }]);

      const projectorRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
        WHERE projector = 'projection.projects'
      `;

      assert.deepEqual(projectorRows, [{ lastAppliedSequence: 1 }]);
    }),
  );

  it.effect("projects persist updated scripts from project.meta.update", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-scripts-project-create"),
        projectId: ProjectId.make("project-scripts"),
        title: "Scripts Project",
        workspaceRoot: "/tmp/project-scripts",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      });

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("cmd-scripts-project-update"),
        projectId: ProjectId.make("project-scripts"),
        scripts: [
          {
            id: "script-1",
            name: "Build",
            command: "bun run build",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
        faviconPath: "brand/icon.svg",
      });

      const projectRows = yield* sql<{
        readonly scriptsJson: string;
        readonly defaultModelSelection: string;
        readonly faviconPath: string | null;
      }>`
        SELECT
          scripts_json AS "scriptsJson",
          default_model_selection_json AS "defaultModelSelection",
          favicon_path AS "faviconPath"
        FROM projection_projects
        WHERE project_id = 'project-scripts'
      `;

      assert.deepEqual(projectRows, [
        {
          scriptsJson:
            '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          defaultModelSelection: '{"instanceId":"codex","model":"gpt-5"}',
          faviconPath: "brand/icon.svg",
        },
      ]);
    }),
  );
});

it.layer(Layer.fresh(makeProjectionPipelinePrefixedTestLayer("t3-projection-skip-")))(
  "OrchestrationProjectionPipeline projector skipping",
  (it) => {
    it.effect("advances every projector cursor while skipping unrelated projectors", () =>
      Effect.gen(function* () {
        const projectionPipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = "2026-01-01T00:00:00.000Z";
        const later = "2026-01-01T00:00:05.000Z";

        const appendAndProject = (event: Parameters<typeof eventStore.append>[0]) =>
          eventStore.append(event).pipe(Effect.tap(projectionPipeline.projectEvent));

        yield* appendAndProject({
          type: "project.created",
          eventId: EventId.make("evt-skip-1"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-skip"),
          occurredAt: now,
          commandId: CommandId.make("cmd-skip-1"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-skip-1"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-skip"),
            title: "Skip Project",
            workspaceRoot: "/tmp/project-skip",
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* appendAndProject({
          type: "thread.created",
          eventId: EventId.make("evt-skip-2"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-skip"),
          occurredAt: now,
          commandId: CommandId.make("cmd-skip-2"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-skip-2"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-skip"),
            projectId: ProjectId.make("project-skip"),
            title: "Skip Thread",
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
        });
        yield* appendAndProject({
          type: "thread.message-sent",
          eventId: EventId.make("evt-skip-3"),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-skip"),
          occurredAt: now,
          commandId: CommandId.make("cmd-skip-3"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-skip-3"),
          metadata: {},
          payload: {
            threadId: ThreadId.make("thread-skip"),
            messageId: MessageId.make("message-skip"),
            role: "assistant",
            text: "kept",
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });

        // Only the projects projector handles this event; every other projector
        // must skip it yet still record the sequence.
        const lastEvent = yield* appendAndProject({
          type: "project.meta-updated",
          eventId: EventId.make("evt-skip-4"),
          aggregateKind: "project",
          aggregateId: ProjectId.make("project-skip"),
          occurredAt: later,
          commandId: CommandId.make("cmd-skip-4"),
          causationEventId: null,
          correlationId: CorrelationId.make("cmd-skip-4"),
          metadata: {},
          payload: {
            projectId: ProjectId.make("project-skip"),
            title: "Renamed Project",
            updatedAt: later,
          },
        });

        const readStateRows = sql<{
          readonly projector: string;
          readonly lastAppliedSequence: number;
          readonly updatedAt: string;
        }>`
          SELECT
            projector,
            last_applied_sequence AS "lastAppliedSequence",
            updated_at AS "updatedAt"
          FROM projection_state
          ORDER BY projector ASC
        `;

        const stateRows = yield* readStateRows;
        assert.deepEqual(
          stateRows.map((row) => row.projector),
          Object.values(ORCHESTRATION_PROJECTOR_NAMES).toSorted(),
        );

        for (const row of stateRows) {
          assert.equal(row.lastAppliedSequence, lastEvent.sequence);
          assert.equal(row.updatedAt, later);
        }

        const readRows = Effect.all({
          projects: sql<{ readonly title: string }>`
            SELECT title FROM projection_projects WHERE project_id = 'project-skip'
          `,
          messages: sql<{ readonly text: string }>`
            SELECT text FROM projection_thread_messages WHERE thread_id = 'thread-skip'
          `,
          threads: sql<{ readonly title: string }>`
            SELECT title FROM projection_threads WHERE thread_id = 'thread-skip'
          `,
        });

        const rows = yield* readRows;
        assert.deepEqual(rows, {
          projects: [{ title: "Renamed Project" }],
          messages: [{ text: "kept" }],
          threads: [{ title: "Skip Thread" }],
        });

        // A restart resumes from the shared cursor without replaying anything.
        yield* projectionPipeline.bootstrap;
        assert.deepEqual(yield* readStateRows, stateRows);
        assert.deepEqual(yield* readRows, rows);
      }),
    );
  },
);
