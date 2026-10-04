import {
  CommandId,
  EventId,
  ProjectId,
  RoutineId,
  SkillAssignmentId,
  SkillId,
  ThreadId,
  type OrchestrationReadModel,
} from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import { BOT_ID, makeReadModel, makeBot, NOW } from "./test-support/BotDeleteFixtures.ts";

it.layer(NodeServices.layer)("bot delete decider", (it) => {
  it.effect("deletes an archived bot", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "bot.delete",
          commandId: CommandId.make("cmd-delete-archived"),
          botId: BOT_ID,
        },
        readModel: makeReadModel({
          bots: [makeBot({ id: BOT_ID, archivedAt: NOW })],
        }),
      });

      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual(["bot.deleted"]);
    }),
  );

  it.effect("rejects a delete pinned to an archive the bot no longer has", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({ bots: [makeBot({ id: BOT_ID })] });

      const error = yield* decideOrchestrationCommand({
        command: {
          type: "bot.delete",
          commandId: CommandId.make("cmd-delete-restored"),
          botId: BOT_ID,
          archivedAt: NOW,
        },
        readModel,
      }).pipe(Effect.flip);

      expect(error.message).toContain("no longer archived");
    }),
  );

  it.effect("deletes the bot's routines and skill assignments", () =>
    Effect.gen(function* () {
      const withRoutine = yield* projectEvent(createEmptyReadModel(NOW), {
        sequence: 1,
        eventId: EventId.make("evt-routine-approved"),
        aggregateKind: "routine",
        aggregateId: RoutineId.make("routine-1"),
        type: "routine.approved",
        occurredAt: NOW,
        commandId: CommandId.make("cmd-routine-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-routine-create"),
        metadata: {},
        payload: {
          routine: {
            id: RoutineId.make("routine-1"),
            botId: BOT_ID,
            delegateToBotId: null,
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
            procedureVersion: 1,
            approvalVersion: 1,
            enabled: true,
            lifecycle: "approved",
            nextRunAt: NOW,
            lastRunAt: null,
            latestResult: null,
            latestFailure: null,
            createdAt: NOW,
            updatedAt: NOW,
            deletedAt: null,
          },
        },
      });

      const readModel = {
        ...(yield* projectEvent(withRoutine, {
          sequence: 2,
          eventId: EventId.make("evt-skill-assigned"),
          aggregateKind: "skill-assignment",
          aggregateId: SkillAssignmentId.make("assignment-1"),
          type: "skill-assignment.assigned",
          occurredAt: NOW,
          commandId: CommandId.make("cmd-skill-assign"),
          causationEventId: null,
          correlationId: CommandId.make("cmd-skill-assign"),
          metadata: {},
          payload: {
            assignment: {
              id: SkillAssignmentId.make("assignment-1"),
              botId: BOT_ID,
              skillId: SkillId.make("skill-1"),
              name: "search",
              description: null,
              createdAt: NOW,
              updatedAt: NOW,
            },
          },
        })),
        bots: [makeBot({ id: BOT_ID })],
      } satisfies OrchestrationReadModel;

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "bot.delete",
          commandId: CommandId.make("cmd-delete-with-routine"),
          botId: BOT_ID,
        },
        readModel,
      });

      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "routine.deleted",
        "skill-assignment.unassigned",
        "bot.deleted",
      ]);
    }),
  );
});
