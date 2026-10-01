import { type OrchestrationCommand, type OrchestrationReadModel } from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import type { OrchestrationDispatchActor } from "../Services/OrchestrationEngine.ts";
import { nextScheduledFor } from "../../routines/schedule.ts";
import { withEventBase, type DecideOrchestrationCommandResult } from "./eventBase.ts";

export const decideRoutines = Effect.fn("decideRoutines")(function* ({
  command,
  readModel,
}: {
  readonly command: Extract<
    OrchestrationCommand,
    {
      type:
        | "routine.create-approved"
        | "routine.draft"
        | "routine.approve"
        | "routine.enable"
        | "routine.pause"
        | "routine.run"
        | "routine.run.scheduled"
        | "routine.run.start"
        | "routine.run.block"
        | "routine.run.fail"
        | "routine.run.complete"
        | "routine.run.cancel"
        | "routine.delete"
        | "routine.skill.assign"
        | "routine.skill.unassign";
    }
  >;
  readonly readModel: OrchestrationReadModel;
  readonly actor?: OrchestrationDispatchActor;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "routine.create-approved": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );

      if (existing !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' already exists.`,
        });
      }

      const routine = {
        id: command.routineId,
        botId: command.botId,
        targetThreadId: command.targetThreadId,
        job: command.job,
        procedure: command.procedure,
        schedule: command.schedule,
        timezone: command.timezone,
        skillAssignmentIds: command.skillAssignmentIds,
        connectorDependencies: command.connectorDependencies,
        projectId: command.projectId,
        sandbox: command.sandbox,
        approvalPolicy: command.approvalPolicy,
        delegateToBotId: command.delegateToBotId,
        procedureVersion: 1,
        approvalVersion: 1,
        enabled: false as const,
        lifecycle: "approved" as const,
        nextRunAt: null,
        lastRunAt: null,
        latestResult: null,
        latestFailure: null,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        deletedAt: null,
      };

      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.approved",
        payload: { routine },
      };
    }

    case "routine.draft": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );

      if (existing?.lifecycle === "deleted") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' is deleted.`,
        });
      }

      if (
        existing !== undefined &&
        command.expectedProcedureVersion !== undefined &&
        command.expectedProcedureVersion !== existing.procedureVersion
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' procedure version changed.`,
        });
      }

      const procedureVersion = (existing?.procedureVersion ?? 0) + 1;

      const routine = {
        id: command.routineId,
        botId: command.botId,
        targetThreadId: command.targetThreadId,
        job: command.job,
        procedure: command.procedure,
        schedule: command.schedule,
        timezone: command.timezone,
        skillAssignmentIds: command.skillAssignmentIds,
        connectorDependencies: command.connectorDependencies,
        projectId: command.projectId,
        sandbox: command.sandbox,
        approvalPolicy: command.approvalPolicy,
        delegateToBotId: command.delegateToBotId,
        procedureVersion,
        approvalVersion: null,
        enabled: false as const,
        lifecycle: "draft" as const,
        nextRunAt: null,
        lastRunAt: existing?.lastRunAt ?? null,
        latestResult: existing?.latestResult ?? null,
        latestFailure: existing?.latestFailure ?? null,
        createdAt: existing?.createdAt ?? command.createdAt,
        updatedAt: command.createdAt,
        deletedAt: null,
      };

      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.drafted",
        payload: { routine },
      };
    }

    case "routine.approve": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );

      if (
        existing === undefined ||
        existing.lifecycle === "deleted" ||
        existing.procedureVersion !== command.procedureVersion
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' cannot approve procedure version ${command.procedureVersion}.`,
        });
      }

      const routine = {
        ...existing,
        approvalVersion: existing.procedureVersion,
        enabled: false,
        lifecycle: "approved" as const,
        updatedAt: command.createdAt,
      };

      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.approved",
        payload: { routine },
      };
    }

    case "routine.enable": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );

      if (
        existing === undefined ||
        existing.lifecycle === "deleted" ||
        existing.approvalVersion !== existing.procedureVersion
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' requires approval before enable.`,
        });
      }

      const routine = {
        ...existing,
        enabled: true,
        lifecycle: "enabled" as const,
        nextRunAt: nextScheduledFor(
          existing.schedule,
          existing.timezone,
          Date.parse(command.createdAt),
        ),
        latestFailure: null,
        updatedAt: command.createdAt,
      };

      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.enabled",
        payload: { routine },
      };
    }

    case "routine.pause": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );

      if (existing === undefined || existing.lifecycle === "deleted") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' does not exist.`,
        });
      }

      const routine = {
        ...existing,
        enabled: false,
        lifecycle: "paused" as const,
        nextRunAt: null,
        updatedAt: command.createdAt,
      };

      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.paused",
        payload: { routine },
      };
    }

    case "routine.run":
    case "routine.run.scheduled": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );

      if (existing === undefined || existing.lifecycle === "deleted") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' does not exist.`,
        });
      }

      if (command.type === "routine.run.scheduled" && !existing.enabled) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' is not enabled.`,
        });
      }

      if (command.trigger !== "dry-run" && existing.approvalVersion !== existing.procedureVersion) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' procedure approval is stale.`,
        });
      }

      if ((readModel.routineRuns ?? []).some((run) => run.id === command.runId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine run '${command.runId}' already exists.`,
        });
      }

      const runBase = {
        id: command.runId,
        routineId: command.routineId,
        procedureVersion: existing.procedureVersion,
        status: "queued" as const,
        result: null,
        failure: null,
        usageRef: null,
        threadRef: null,
        startedAt: null,
        completedAt: null,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };

      const run =
        command.type === "routine.run.scheduled"
          ? {
              ...runBase,
              trigger: command.trigger,
              scheduledFor: command.scheduledFor,
            }
          : { ...runBase, trigger: command.trigger, scheduledFor: null };

      const routine = {
        ...existing,
        lifecycle: "running" as const,
        lastRunAt: command.createdAt,
        updatedAt: command.createdAt,
      };

      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.running",
        payload: { routine, run },
      };
    }

    case "routine.run.start":
    case "routine.run.block":
    case "routine.run.fail":
    case "routine.run.complete":
    case "routine.run.cancel": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );

      const existingRun = (readModel.routineRuns ?? []).find((run) => run.id === command.runId);

      if (existing === undefined || existing.lifecycle === "deleted" || existingRun === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine run '${command.runId}' does not exist.`,
        });
      }

      // A run canceled or settled before it started stays ended, and a
      // cancellation never overwrites a run that already ended.
      if (
        (command.type === "routine.run.start" || command.type === "routine.run.cancel") &&
        existingRun.status !== "queued" &&
        existingRun.status !== "waiting-for-approval" &&
        existingRun.status !== "running"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine run '${command.runId}' already ended with status '${existingRun.status}'.`,
        });
      }

      const occurredAt =
        command.type === "routine.run.start" ? command.startedAt : command.createdAt;

      const run =
        command.type === "routine.run.start"
          ? {
              ...existingRun,
              status: "running" as const,
              threadRef: command.threadRef,
              startedAt: command.startedAt,
              updatedAt: command.startedAt,
            }
          : command.type === "routine.run.block"
            ? {
                ...existingRun,
                status: "blocked" as const,
                failure: command.failure,
                completedAt: command.createdAt,
                updatedAt: command.createdAt,
              }
            : command.type === "routine.run.fail"
              ? {
                  ...existingRun,
                  status: "failed" as const,
                  failure: command.failure,
                  usageRef: command.usageRef,
                  completedAt: command.createdAt,
                  updatedAt: command.createdAt,
                }
              : command.type === "routine.run.complete"
                ? {
                    ...existingRun,
                    status: "completed" as const,
                    result: command.result,
                    usageRef: command.usageRef,
                    completedAt: command.createdAt,
                    updatedAt: command.createdAt,
                  }
                : {
                    ...existingRun,
                    status: "canceled" as const,
                    completedAt: command.createdAt,
                    updatedAt: command.createdAt,
                  };

      const terminal = command.type !== "routine.run.start";

      const blockedOrFailed =
        command.type === "routine.run.block" || command.type === "routine.run.fail";

      const routine = {
        ...existing,
        enabled: blockedOrFailed ? false : existing.enabled,
        lifecycle:
          command.type === "routine.run.start"
            ? ("running" as const)
            : command.type === "routine.run.block"
              ? ("blocked" as const)
              : command.type === "routine.run.fail"
                ? ("failed" as const)
                : command.type === "routine.run.complete" && existing.enabled
                  ? ("enabled" as const)
                  : command.type === "routine.run.complete"
                    ? ("completed" as const)
                    : existing.enabled
                      ? ("enabled" as const)
                      : ("paused" as const),
        nextRunAt:
          command.type === "routine.run.complete"
            ? command.nextRunAt
            : blockedOrFailed
              ? null
              : existing.nextRunAt,
        lastRunAt: terminal ? occurredAt : existing.lastRunAt,
        latestResult:
          command.type === "routine.run.complete" ? command.result : existing.latestResult,
        latestFailure:
          command.type === "routine.run.block" || command.type === "routine.run.fail"
            ? command.failure
            : existing.latestFailure,
        updatedAt: occurredAt,
      };

      const type =
        command.type === "routine.run.start"
          ? ("routine.running" as const)
          : command.type === "routine.run.block"
            ? ("routine.blocked" as const)
            : command.type === "routine.run.fail"
              ? ("routine.failed" as const)
              : command.type === "routine.run.complete"
                ? ("routine.completed" as const)
                : ("routine.run-canceled" as const);

      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt,
          commandId: command.commandId,
        })),
        type,
        payload: { routine, run },
      };
    }

    case "routine.delete": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );

      if (existing === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' does not exist.`,
        });
      }

      const routine = {
        ...existing,
        enabled: false,
        lifecycle: "deleted" as const,
        nextRunAt: null,
        updatedAt: command.createdAt,
        deletedAt: command.createdAt,
      };

      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.deleted",
        payload: { routine },
      };
    }

    case "routine.skill.assign": {
      if (
        (readModel.skillAssignments ?? []).some(
          (assignment) => assignment.id === command.assignmentId,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Skill assignment '${command.assignmentId}' already exists.`,
        });
      }

      const assignment = {
        id: command.assignmentId,
        botId: command.botId,
        skillId: command.skillId,
        name: command.name,
        description: command.description,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };

      return {
        ...(yield* withEventBase({
          aggregateKind: "skill-assignment",
          aggregateId: command.assignmentId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "skill-assignment.assigned",
        payload: { assignment },
      };
    }

    case "routine.skill.unassign": {
      const assignment = (readModel.skillAssignments ?? []).find(
        (entry) => entry.id === command.assignmentId && entry.botId === command.botId,
      );

      if (assignment === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Skill assignment '${command.assignmentId}' does not exist.`,
        });
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: "skill-assignment",
          aggregateId: command.assignmentId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "skill-assignment.unassigned",
        payload: {
          assignmentId: command.assignmentId,
          botId: command.botId,
          removedAt: command.createdAt,
        },
      };
    }
  }
});
