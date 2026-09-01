import {
  BotId,
  CommandId,
  EventId,
  ProjectId,
  RoutineId,
  RoutineRunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-31T13:00:00.000Z";

it.layer(NodeServices.layer)("routine decider", (it) => {
  it.effect("creates an already-approved routine atomically", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "routine.create-approved",
          commandId: CommandId.make("command-routine-approved"),
          routineId: RoutineId.make("routine-approved"),
          botId: BotId.make("bot-1"),
          targetThreadId: ThreadId.make("thread-1"),
          job: "Daily brief",
          procedure: "Summarize this chat.",
          schedule: { kind: "weekdays", time: "09:00" },
          timezone: "America/New_York",
          skillAssignmentIds: [],
          connectorDependencies: [],
          projectId: ProjectId.make("project-1"),
          sandbox: "local",
          approvalPolicy: "approval-required",
          createdAt: NOW,
        },
        readModel: createEmptyReadModel(NOW),
      });
      const events = Array.isArray(event) ? event : [event];

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("routine.approved");
      if (events[0]?.type === "routine.approved") {
        expect(events[0].payload.routine).toMatchObject({
          lifecycle: "approved",
          procedureVersion: 1,
          approvalVersion: 1,
          enabled: false,
        });
      }
    }),
  );

  it.effect("deletes a routine and disables future runs", () =>
    Effect.gen(function* () {
      const readModel = createEmptyReadModel(NOW);
      const created = yield* decideOrchestrationCommand({
        command: {
          type: "routine.create-approved",
          commandId: CommandId.make("command-routine-create-for-delete"),
          routineId: RoutineId.make("routine-delete"),
          botId: BotId.make("bot-1"),
          targetThreadId: ThreadId.make("thread-1"),
          job: "Daily brief",
          procedure: "Summarize this chat.",
          schedule: { kind: "daily", time: "09:00" },
          timezone: "America/New_York",
          skillAssignmentIds: [],
          connectorDependencies: [],
          projectId: ProjectId.make("project-1"),
          sandbox: "local",
          approvalPolicy: "approval-required",
          createdAt: NOW,
        },
        readModel,
      });
      const createdEvent = Array.isArray(created) ? created[0] : created;
      const withRoutine = yield* projectEvent(readModel, {
        ...createdEvent,
        sequence: 1,
        eventId: EventId.make("event-routine-created-for-delete"),
      });
      const started = yield* decideOrchestrationCommand({
        command: {
          type: "routine.run",
          commandId: CommandId.make("command-routine-run-before-delete"),
          routineId: RoutineId.make("routine-delete"),
          runId: RoutineRunId.make("run-before-delete"),
          trigger: "manual",
          createdAt: NOW,
        },
        readModel: withRoutine,
      });
      const startedEvent = Array.isArray(started) ? started[0] : started;
      const withRun = yield* projectEvent(withRoutine, {
        ...startedEvent,
        sequence: 2,
        eventId: EventId.make("event-routine-run-before-delete"),
      });
      const deletedAt = "2026-08-31T14:00:00.000Z";

      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "routine.delete",
          commandId: CommandId.make("command-routine-delete"),
          routineId: RoutineId.make("routine-delete"),
          createdAt: deletedAt,
        },
        readModel: withRun,
      });
      const deletedEvent = Array.isArray(deleted) ? deleted[0] : deleted;

      expect(deletedEvent?.type).toBe("routine.deleted");
      if (deletedEvent?.type === "routine.deleted") {
        expect(deletedEvent.payload.routine).toMatchObject({
          id: RoutineId.make("routine-delete"),
          enabled: false,
          lifecycle: "deleted",
          nextRunAt: null,
          updatedAt: deletedAt,
          deletedAt,
        });
      }
      const afterDelete = yield* projectEvent(withRun, {
        ...deletedEvent,
        sequence: 3,
        eventId: EventId.make("event-routine-deleted"),
      });
      const completionError = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "routine.run.complete",
            commandId: CommandId.make("command-routine-complete-after-delete"),
            routineId: RoutineId.make("routine-delete"),
            runId: RoutineRunId.make("run-before-delete"),
            result: { summary: "Late completion" },
            usageRef: null,
            nextRunAt: null,
            createdAt: "2026-08-31T14:01:00.000Z",
          },
          readModel: afterDelete,
        }),
      );
      expect(completionError.message).toContain("does not exist");
    }),
  );

  it.effect("rejects deletion when the routine does not exist", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "routine.delete",
            commandId: CommandId.make("command-missing-routine-delete"),
            routineId: RoutineId.make("routine-missing"),
            createdAt: NOW,
          },
          readModel: createEmptyReadModel(NOW),
        }),
      );

      expect(error.message).toContain("Routine 'routine-missing' does not exist.");
    }),
  );
});
