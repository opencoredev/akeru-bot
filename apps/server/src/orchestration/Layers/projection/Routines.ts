import * as Effect from "effect/Effect";
import { toPersistenceSqlError } from "../../../persistence/Errors.ts";
import {
  type ProjectionDependencies,
  type ProjectorDefinition,
  encodeRoutineSchedule,
  encodeSkillAssignmentIds,
  encodeMcpServerIds,
  encodeRoutineResult,
  encodeRoutineFailure,
} from "./Definitions.ts";

export function createRoutines({ sql }: Pick<ProjectionDependencies, "sql">) {
  const applyRoutinesProjection: ProjectorDefinition["apply"] = Effect.fn(
    "applyRoutinesProjection",
  )(function* (event, _attachmentSideEffects) {
    if (event.type === "skill-assignment.assigned") {
      const assignment = event.payload.assignment;
      yield* sql`
          INSERT INTO projection_routine_skill_assignments (
            assignment_id, bot_id, skill_id, name, description, created_at, updated_at
          ) VALUES (
            ${assignment.id}, ${assignment.botId}, ${assignment.skillId}, ${assignment.name},
            ${assignment.description}, ${assignment.createdAt}, ${assignment.updatedAt}
          ) ON CONFLICT (assignment_id) DO UPDATE SET
            bot_id = excluded.bot_id,
            skill_id = excluded.skill_id,
            name = excluded.name,
            description = excluded.description,
            updated_at = excluded.updated_at
        `.pipe(Effect.mapError(toPersistenceSqlError("ProjectionPipeline.routines:assignment")));
      return;
    }
    if (event.type === "skill-assignment.unassigned") {
      yield* sql`
          DELETE FROM projection_routine_skill_assignments
          WHERE assignment_id = ${event.payload.assignmentId}
        `.pipe(Effect.mapError(toPersistenceSqlError("ProjectionPipeline.routines:unassign")));
      return;
    }

    switch (event.type) {
      case "routine.drafted":
      case "routine.approved":
      case "routine.enabled":
      case "routine.running":
      case "routine.paused":
      case "routine.blocked":
      case "routine.failed":
      case "routine.completed":
      case "routine.run-canceled":
      case "routine.deleted":
        break;
      default:
        return;
    }

    const routine = event.payload.routine;
    yield* sql`
        INSERT INTO projection_routines (
          routine_id, bot_id, target_thread_id, project_id, job, procedure, procedure_version,
          approval_version, schedule_json, timezone, skill_assignment_ids_json,
          connector_dependencies_json, sandbox, approval_policy, delegate_to_bot_id, enabled,
          lifecycle, next_run_at, last_run_at, latest_result_json, latest_failure_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          ${routine.id}, ${routine.botId}, ${routine.targetThreadId}, ${routine.projectId}, ${routine.job},
          ${routine.procedure}, ${routine.procedureVersion}, ${routine.approvalVersion},
          ${encodeRoutineSchedule(routine.schedule)}, ${routine.timezone},
          ${encodeSkillAssignmentIds(routine.skillAssignmentIds)},
          ${encodeMcpServerIds(routine.connectorDependencies)}, ${routine.sandbox},
          ${routine.approvalPolicy}, ${routine.delegateToBotId}, ${routine.enabled ? 1 : 0},
          ${routine.lifecycle},
          ${routine.nextRunAt}, ${routine.lastRunAt},
          ${routine.latestResult === null ? null : encodeRoutineResult(routine.latestResult)},
          ${routine.latestFailure === null ? null : encodeRoutineFailure(routine.latestFailure)},
          ${routine.createdAt}, ${routine.updatedAt}, ${routine.deletedAt}
        ) ON CONFLICT (routine_id) DO UPDATE SET
          bot_id = excluded.bot_id,
          target_thread_id = excluded.target_thread_id,
          project_id = excluded.project_id,
          job = excluded.job,
          procedure = excluded.procedure,
          procedure_version = excluded.procedure_version,
          approval_version = excluded.approval_version,
          schedule_json = excluded.schedule_json,
          timezone = excluded.timezone,
          skill_assignment_ids_json = excluded.skill_assignment_ids_json,
          connector_dependencies_json = excluded.connector_dependencies_json,
          sandbox = excluded.sandbox,
          approval_policy = excluded.approval_policy,
          delegate_to_bot_id = excluded.delegate_to_bot_id,
          enabled = excluded.enabled,
          lifecycle = excluded.lifecycle,
          next_run_at = excluded.next_run_at,
          last_run_at = excluded.last_run_at,
          latest_result_json = excluded.latest_result_json,
          latest_failure_json = excluded.latest_failure_json,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `.pipe(Effect.mapError(toPersistenceSqlError("ProjectionPipeline.routines:routine")));

    if (!("run" in event.payload)) return;
    const run = event.payload.run;
    yield* sql`
        INSERT INTO projection_routine_runs (
          run_id, routine_id, procedure_version, trigger, scheduled_for, status,
          thread_ref, result_json, failure_json, usage_ref, started_at, completed_at,
          created_at, updated_at
        ) VALUES (
          ${run.id}, ${run.routineId}, ${run.procedureVersion}, ${run.trigger},
          ${run.scheduledFor}, ${run.status}, ${run.threadRef},
          ${run.result === null ? null : encodeRoutineResult(run.result)},
          ${run.failure === null ? null : encodeRoutineFailure(run.failure)},
          ${run.usageRef}, ${run.startedAt}, ${run.completedAt}, ${run.createdAt}, ${run.updatedAt}
        ) ON CONFLICT (run_id) DO UPDATE SET
          status = excluded.status,
          thread_ref = excluded.thread_ref,
          result_json = excluded.result_json,
          failure_json = excluded.failure_json,
          usage_ref = excluded.usage_ref,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(toPersistenceSqlError("ProjectionPipeline.routines:run")));
  });
  return { applyRoutinesProjection };
}
