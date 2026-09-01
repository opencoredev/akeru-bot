import { BotId, McpServerId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { RoutineRepository, type RoutineClaim, type RoutineRepositoryShape } from "./Repository.ts";
import type { Routine, RoutineRun } from "./types.ts";

const RoutineRow = Schema.Struct({
  id: Schema.String,
  botId: BotId,
  targetThreadId: ThreadId,
  projectId: ProjectId,
  job: Schema.String,
  procedure: Schema.String,
  procedureVersion: Schema.Number,
  approvalVersion: Schema.NullOr(Schema.Number),
  schedule: Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literals(["daily", "weekdays"]), time: Schema.String }),
      Schema.Struct({
        kind: Schema.Literal("weekly"),
        weekdays: Schema.Array(
          Schema.Literals([
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
          ]),
        ),
        time: Schema.String,
      }),
    ]),
  ),
  timezone: Schema.String,
  skillAssignmentIds: Schema.fromJsonString(Schema.Array(Schema.String)),
  connectorDependencies: Schema.fromJsonString(Schema.Array(McpServerId)),
  sandbox: Schema.String,
  approvalPolicy: Schema.String,
  enabled: Schema.Number,
  lifecycle: Schema.Literals([
    "draft",
    "approved",
    "enabled",
    "running",
    "paused",
    "blocked",
    "failed",
    "completed",
    "deleted",
  ]),
  nextRunAt: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  latestResult: Schema.NullOr(Schema.fromJsonString(Schema.Struct({ summary: Schema.String }))),
  latestFailure: Schema.NullOr(
    Schema.fromJsonString(Schema.Struct({ kind: Schema.String, message: Schema.String })),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});

const RoutineRunRow = Schema.Struct({
  id: Schema.String,
  routineId: Schema.String,
  procedureVersion: Schema.Number,
  trigger: Schema.Literals(["dry-run", "manual", "scheduled", "missed"]),
  scheduledFor: Schema.NullOr(Schema.String),
  status: Schema.Literals([
    "queued",
    "running",
    "waiting-for-approval",
    "completed",
    "failed",
    "canceled",
    "blocked",
  ]),
  threadRef: Schema.NullOr(ThreadId),
  result: Schema.NullOr(Schema.fromJsonString(Schema.Struct({ summary: Schema.String }))),
  failure: Schema.NullOr(
    Schema.fromJsonString(Schema.Struct({ kind: Schema.String, message: Schema.String })),
  ),
  usageRef: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const SkillAssignmentRow = Schema.Struct({
  id: Schema.String,
  botId: BotId,
  skillId: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const decodeRoutine = Schema.decodeUnknownSync(RoutineRow);
const decodeRun = Schema.decodeUnknownSync(RoutineRunRow);
const decodeSkillAssignment = Schema.decodeUnknownSync(SkillAssignmentRow);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readRoutines = (parameter?: string) =>
    parameter === undefined
      ? sql<Record<string, unknown>>`
          SELECT routine_id AS id, bot_id AS "botId", target_thread_id AS "targetThreadId",
            project_id AS "projectId", job,
            procedure, procedure_version AS "procedureVersion",
            approval_version AS "approvalVersion", schedule_json AS schedule, timezone,
            skill_assignment_ids_json AS "skillAssignmentIds",
            connector_dependencies_json AS "connectorDependencies", sandbox,
            approval_policy AS "approvalPolicy", enabled, lifecycle,
            next_run_at AS "nextRunAt", last_run_at AS "lastRunAt",
            latest_result_json AS "latestResult", latest_failure_json AS "latestFailure",
            created_at AS "createdAt", updated_at AS "updatedAt", deleted_at AS "deletedAt"
          FROM projection_routines ORDER BY created_at, routine_id
        `
      : sql<Record<string, unknown>>`
          SELECT routine_id AS id, bot_id AS "botId", target_thread_id AS "targetThreadId",
            project_id AS "projectId", job,
            procedure, procedure_version AS "procedureVersion",
            approval_version AS "approvalVersion", schedule_json AS schedule, timezone,
            skill_assignment_ids_json AS "skillAssignmentIds",
            connector_dependencies_json AS "connectorDependencies", sandbox,
            approval_policy AS "approvalPolicy", enabled, lifecycle,
            next_run_at AS "nextRunAt", last_run_at AS "lastRunAt",
            latest_result_json AS "latestResult", latest_failure_json AS "latestFailure",
            created_at AS "createdAt", updated_at AS "updatedAt", deleted_at AS "deletedAt"
          FROM projection_routines WHERE routine_id = ${parameter}
        `;

  const listAll: RoutineRepositoryShape["listAll"] = readRoutines().pipe(
    Effect.map((rows) =>
      rows.map((row) => {
        const decoded = decodeRoutine(row);
        return { ...decoded, enabled: decoded.enabled === 1 } as Routine;
      }),
    ),
    Effect.mapError(toPersistenceSqlError("RoutineRepository.listAll")),
  );

  const listEnabled: RoutineRepositoryShape["listEnabled"] = listAll.pipe(
    Effect.map((routines) => routines.filter((routine) => routine.enabled)),
  );

  const getById: RoutineRepositoryShape["getById"] = (routineId) =>
    readRoutines(routineId).pipe(
      Effect.map((rows) => {
        if (rows[0] === undefined) return null;
        const decoded = decodeRoutine(rows[0]);
        return { ...decoded, enabled: decoded.enabled === 1 } as Routine;
      }),
      Effect.mapError(toPersistenceSqlError("RoutineRepository.getById")),
    );

  const listRuns: RoutineRepositoryShape["listRuns"] = (routineId) =>
    sql<Record<string, unknown>>`
      SELECT run_id AS id, routine_id AS "routineId", procedure_version AS "procedureVersion",
        trigger, scheduled_for AS "scheduledFor", status, thread_ref AS "threadRef",
        result_json AS result, failure_json AS failure, usage_ref AS "usageRef",
        started_at AS "startedAt", completed_at AS "completedAt", created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_routine_runs
      WHERE routine_id = ${routineId}
      ORDER BY scheduled_for DESC, run_id DESC
    `.pipe(
      Effect.map((rows) => rows.map((row) => decodeRun(row) as RoutineRun)),
      Effect.mapError(toPersistenceSqlError("RoutineRepository.listRuns")),
    );

  const listAllRuns: RoutineRepositoryShape["listAllRuns"] = sql<Record<string, unknown>>`
    SELECT run_id AS id, routine_id AS "routineId", procedure_version AS "procedureVersion",
      trigger, scheduled_for AS "scheduledFor", status, thread_ref AS "threadRef",
      result_json AS result, failure_json AS failure, usage_ref AS "usageRef",
      started_at AS "startedAt", completed_at AS "completedAt", created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM projection_routine_runs
    WHERE run_id IN (
      SELECT run_id FROM (
        SELECT run_id,
          ROW_NUMBER() OVER (
            PARTITION BY routine_id ORDER BY created_at DESC, run_id DESC
          ) AS history_rank
        FROM projection_routine_runs
      ) WHERE history_rank <= 5
    )
    ORDER BY created_at, run_id
  `.pipe(
    Effect.map((rows) => rows.map((row) => decodeRun(row) as RoutineRun)),
    Effect.mapError(toPersistenceSqlError("RoutineRepository.listAllRuns")),
  );

  const getActiveRunByThreadRef: RoutineRepositoryShape["getActiveRunByThreadRef"] = (
    threadRef,
    turnId = null,
  ) =>
    sql<Record<string, unknown>>`
        SELECT run_id AS id, routine_id AS "routineId", procedure_version AS "procedureVersion",
          trigger, scheduled_for AS "scheduledFor", status, thread_ref AS "threadRef",
          result_json AS result, failure_json AS failure, usage_ref AS "usageRef",
          started_at AS "startedAt", completed_at AS "completedAt", created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_routine_runs
        WHERE thread_ref = ${threadRef}
          AND status IN ('queued', 'running', 'waiting-for-approval')
          AND EXISTS (
            SELECT 1 FROM projection_turns AS turn
            WHERE turn.thread_id = ${threadRef}
              AND turn.pending_message_id = 'routine:' || projection_routine_runs.run_id || ':message'
              AND (${turnId} IS NULL OR turn.turn_id = ${turnId})
              AND turn.state IN ('completed', 'error', 'interrupted')
          )
        ORDER BY updated_at DESC LIMIT 1
      `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : (decodeRun(rows[0]) as RoutineRun))),
      Effect.mapError(toPersistenceSqlError("RoutineRepository.getActiveRunByThreadRef")),
    );

  const listSkillAssignments: RoutineRepositoryShape["listSkillAssignments"] = sql<
    Record<string, unknown>
  >`
    SELECT assignment_id AS id, bot_id AS "botId", skill_id AS "skillId", name,
      description, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM projection_routine_skill_assignments
    ORDER BY created_at, assignment_id
  `.pipe(
    Effect.map((rows) => rows.map((row) => decodeSkillAssignment(row)) as never),
    Effect.mapError(toPersistenceSqlError("RoutineRepository.listSkillAssignments")),
  );

  const claim: RoutineRepositoryShape["claim"] = (input) =>
    sql<{ readonly runId: string }>`
      INSERT INTO routine_run_claims (
        run_id, routine_id, trigger, scheduled_for, status, claimed_at, updated_at
      ) VALUES (
        ${input.runId}, ${input.routineId}, ${input.trigger}, ${input.scheduledFor},
        'claimed', ${input.claimedAt}, ${input.claimedAt}
      )
      ON CONFLICT DO NOTHING
      RETURNING run_id AS "runId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("RoutineRepository.claim")),
    );

  const markDispatched: RoutineRepositoryShape["markDispatched"] = (runId, threadId) =>
    sql`
      UPDATE routine_run_claims
      SET status = 'dispatched', thread_id = ${threadId}, updated_at = CURRENT_TIMESTAMP
      WHERE run_id = ${runId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("RoutineRepository.markDispatched")),
    );

  const markBlocked: RoutineRepositoryShape["markBlocked"] = (runId, failure, completedAt) =>
    sql`
      UPDATE routine_run_claims
      SET status = 'blocked', failure = ${failure}, completed_at = ${completedAt},
        updated_at = ${completedAt}
      WHERE run_id = ${runId}
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("RoutineRepository.markBlocked")));

  const markSettled: RoutineRepositoryShape["markSettled"] = (runId, status, completedAt) =>
    sql`
      UPDATE routine_run_claims
      SET status = ${status}, completed_at = ${completedAt}, updated_at = ${completedAt}
      WHERE run_id = ${runId}
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("RoutineRepository.markSettled")));

  const listRecoverable: RoutineRepositoryShape["listRecoverable"] = sql<{
    readonly runId: string;
    readonly routineId: string;
    readonly trigger: "dry-run" | "manual" | "scheduled" | "missed";
    readonly scheduledFor: string | null;
    readonly claimedAt: string;
    readonly status: "claimed" | "dispatched";
    readonly threadRef: string | null;
    readonly terminalState: "completed" | "error" | "interrupted" | null;
    readonly terminalAt: string | null;
  }>`
    SELECT run_id AS "runId", routine_id AS "routineId", trigger,
      scheduled_for AS "scheduledFor", claimed_at AS "claimedAt", claims.status,
      claims.thread_id AS "threadRef", turns.state AS "terminalState",
      turns.completed_at AS "terminalAt"
    FROM routine_run_claims AS claims
    LEFT JOIN projection_turns AS turns ON turns.row_id = (
      SELECT MAX(candidate.row_id) FROM projection_turns AS candidate
      WHERE candidate.thread_id = claims.thread_id
        AND candidate.pending_message_id = 'routine:' || claims.run_id || ':message'
        AND candidate.state IN ('completed', 'error', 'interrupted')
    )
    WHERE claims.status IN ('claimed', 'dispatched')
    ORDER BY claimed_at, run_id
  `.pipe(
    Effect.map((rows) => rows as ReadonlyArray<RoutineClaim>),
    Effect.mapError(toPersistenceSqlError("RoutineRepository.listRecoverable")),
  );

  return {
    listAll,
    listEnabled,
    getById,
    listRuns,
    listAllRuns,
    getActiveRunByThreadRef,
    listSkillAssignments,
    claim,
    markDispatched,
    markBlocked,
    markSettled,
    listRecoverable,
  } satisfies RoutineRepositoryShape;
});

export const RoutineRepositoryLive = Layer.effect(RoutineRepository, make);
