import {
  DelegationCreatedPayload,
  DelegationUpdatedPayload,
  RoutineApprovedPayload,
  RoutineBlockedPayload,
  RoutineCompletedPayload,
  RoutineDeletedPayload,
  RoutineDraftedPayload,
  RoutineEnabledPayload,
  RoutineFailedPayload,
  RoutinePausedPayload,
  RoutineRunCanceledPayload,
  RoutineRunningPayload,
  RoutineSkillAssignedPayload,
  RoutineSkillUnassignedPayload,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import {
  McpServerCreatedPayload,
  McpServerDeletedPayload,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
} from "../Schemas.ts";
import type { OrchestrationReadModel, OrchestrationEvent } from "@akeru/contracts";
import type { OrchestrationProjectorDecodeError } from "../Errors.ts";
import { decodeForEvent } from "./Updates.ts";

export function projectEnvironment(
  nextBase: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  switch (event.type) {
    case "delegation.created":
    case "delegation.updated":
      return decodeForEvent(
        event.type === "delegation.created" ? DelegationCreatedPayload : DelegationUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          delegations: nextBase.delegations.some(
            (entry) => entry.delegationId === payload.delegation.delegationId,
          )
            ? nextBase.delegations.map((entry) =>
                entry.delegationId === payload.delegation.delegationId ? payload.delegation : entry,
              )
            : [...nextBase.delegations, payload.delegation],
        })),
      );
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);

          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            defaultThreadEnvMode: null,
            faviconPath: payload.faviconPath ?? null,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );
    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.defaultThreadEnvMode !== undefined
                    ? { defaultThreadEnvMode: payload.defaultThreadEnvMode }
                    : {}),
                  ...(payload.faviconPath !== undefined
                    ? { faviconPath: payload.faviconPath }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );
    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );
    case "mcp-server.created":
    case "mcp-server.updated":
    case "mcp-server.enabled":
    case "mcp-server.disabled": {
      return decodeForEvent(McpServerCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const mcpServers = nextBase.mcpServers ?? [];

          return {
            ...nextBase,
            mcpServers: mcpServers.some((entry) => entry.id === payload.mcpServer.id)
              ? mcpServers.map((entry) =>
                  entry.id === payload.mcpServer.id ? payload.mcpServer : entry,
                )
              : [...mcpServers, payload.mcpServer],
          };
        }),
      );
    }

    case "mcp-server.deleted":
      return decodeForEvent(McpServerDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          mcpServers: (nextBase.mcpServers ?? []).filter(
            (entry) => entry.id !== payload.mcpServerId,
          ),
        })),
      );
    case "routine.drafted":
    case "routine.approved":
    case "routine.enabled":
    case "routine.paused":
    case "routine.deleted": {
      const schema =
        event.type === "routine.drafted"
          ? RoutineDraftedPayload
          : event.type === "routine.approved"
            ? RoutineApprovedPayload
            : event.type === "routine.enabled"
              ? RoutineEnabledPayload
              : event.type === "routine.paused"
                ? RoutinePausedPayload
                : RoutineDeletedPayload;

      return decodeForEvent(schema, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const routines = nextBase.routines ?? [];

          return {
            ...nextBase,
            routines: routines.some((routine) => routine.id === payload.routine.id)
              ? routines.map((routine) =>
                  routine.id === payload.routine.id ? payload.routine : routine,
                )
              : [...routines, payload.routine],
          };
        }),
      );
    }

    case "routine.running":
    case "routine.blocked":
    case "routine.failed":
    case "routine.completed":
    case "routine.run-canceled": {
      const schema =
        event.type === "routine.running"
          ? RoutineRunningPayload
          : event.type === "routine.blocked"
            ? RoutineBlockedPayload
            : event.type === "routine.failed"
              ? RoutineFailedPayload
              : event.type === "routine.completed"
                ? RoutineCompletedPayload
                : RoutineRunCanceledPayload;

      return decodeForEvent(schema, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const routines = nextBase.routines ?? [];
          const runs = nextBase.routineRuns ?? [];

          return {
            ...nextBase,
            routines: routines.some((routine) => routine.id === payload.routine.id)
              ? routines.map((routine) =>
                  routine.id === payload.routine.id ? payload.routine : routine,
                )
              : [...routines, payload.routine],
            routineRuns: runs.some((run) => run.id === payload.run.id)
              ? runs.map((run) => (run.id === payload.run.id ? payload.run : run))
              : [...runs, payload.run],
          };
        }),
      );
    }

    case "skill-assignment.assigned":
      return decodeForEvent(RoutineSkillAssignedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const assignments = nextBase.skillAssignments ?? [];

          return {
            ...nextBase,
            skillAssignments: assignments.some((entry) => entry.id === payload.assignment.id)
              ? assignments.map((entry) =>
                  entry.id === payload.assignment.id ? payload.assignment : entry,
                )
              : [...assignments, payload.assignment],
          };
        }),
      );
    case "skill-assignment.unassigned":
      return decodeForEvent(
        RoutineSkillUnassignedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          skillAssignments: (nextBase.skillAssignments ?? []).filter(
            (entry) => entry.id !== payload.assignmentId,
          ),
        })),
      );
    default:
      throw new Error("Unexpected projector event: " + event.type);
  }
}
