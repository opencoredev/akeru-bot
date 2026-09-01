import {
  BotId,
  CommandId,
  type Routine,
  RoutineId,
  RoutineTimeZone,
  ThreadId,
  type AkeruCreateRoutineInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export interface RoutineApprovedResult {
  readonly routineId: RoutineId;
  readonly sequence: number;
  readonly status: "approved";
}

export interface RoutinesDeletedResult {
  readonly routineIds: ReadonlyArray<RoutineId>;
  readonly sequences: ReadonlyArray<number>;
  readonly status: "deleted";
}

export type AkeruRoutineStatus = Pick<Routine, "id" | "enabled"> & {
  readonly name: string;
  readonly lifecycle: Exclude<Routine["lifecycle"], "deleted">;
};

export function routineStatusesForBot(
  routines: ReadonlyArray<Routine>,
  botId: BotId,
): ReadonlyArray<AkeruRoutineStatus> {
  return routines.flatMap((routine) =>
    routine.botId === botId && routine.lifecycle !== "deleted" && routine.deletedAt === null
      ? [
          {
            id: routine.id,
            name: routine.job,
            enabled: routine.enabled,
            lifecycle: routine.lifecycle,
          },
        ]
      : [],
  );
}

export class RoutineDraftError extends Schema.TaggedErrorClass<RoutineDraftError>()(
  "RoutineDraftError",
  { message: Schema.String },
) {}

export interface RoutineDraftDispatcherShape {
  readonly createApprovedForThread: (
    threadId: ThreadId,
    timezone: string,
    input: AkeruCreateRoutineInput,
  ) => Effect.Effect<RoutineApprovedResult, RoutineDraftError>;
  readonly listForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<AkeruRoutineStatus>, RoutineDraftError>;
  readonly deleteForThread: (
    threadId: ThreadId,
    routineIds: ReadonlyArray<RoutineId>,
  ) => Effect.Effect<RoutinesDeletedResult, RoutineDraftError>;
}

export class RoutineDraftDispatcher extends Context.Service<
  RoutineDraftDispatcher,
  RoutineDraftDispatcherShape
>()("akeru-bot/routines/RoutineDraftDispatcher") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const decodeTimezone = Schema.decodeUnknownEffect(RoutineTimeZone);
  const fail = (message: string) => new RoutineDraftError({ message });

  const createApprovedForThread: RoutineDraftDispatcherShape["createApprovedForThread"] = (
    threadId,
    timezone,
    input,
  ) =>
    Effect.gen(function* () {
      const thread = Option.getOrUndefined(yield* snapshots.getThreadDetailById(threadId));
      if (!thread || thread.archivedAt !== null) {
        return yield* fail("The current chat is unavailable.");
      }
      const botId = thread.respondingBotId ?? thread.botId;
      if (botId === null || botId === undefined) {
        return yield* fail("Routines can only be created from a bot chat.");
      }
      const decodedTimezone = yield* decodeTimezone(timezone).pipe(
        Effect.mapError(() => fail("The current device timezone is invalid.")),
      );
      const snapshot = yield* snapshots.getShellSnapshot();
      const bot = snapshot.bots.find(
        (candidate) => candidate.id === botId && candidate.archivedAt === null,
      );
      if (!bot) return yield* fail("The current bot is unavailable.");

      const requestedSkills = new Set((input.skillNames ?? []).map((name) => name.toLowerCase()));
      const skillAssignmentIds = (snapshot.skillAssignments ?? [])
        .filter(
          (assignment) =>
            assignment.botId === botId && requestedSkills.has(assignment.name.toLowerCase()),
        )
        .map((assignment) => assignment.id);
      if (skillAssignmentIds.length !== requestedSkills.size) {
        return yield* fail("Assign the requested skills to this bot first.");
      }

      const requestedConnectors = new Set(
        (input.connectorNames ?? []).map((name) => name.toLowerCase()),
      );
      const connectorDependencies = (snapshot.mcpServers ?? [])
        .filter((server) => server.enabled && requestedConnectors.has(server.name.toLowerCase()))
        .map((server) => server.id);
      if (connectorDependencies.length !== requestedConnectors.size) {
        return yield* fail("Connect the requested plugin first.");
      }

      const uuid = yield* crypto.randomUUIDv4;
      const now = DateTime.formatIso(yield* DateTime.now);
      const routineId = RoutineId.make(uuid);
      const result = yield* engine.dispatch({
        type: "routine.create-approved",
        commandId: CommandId.make(`agent:routine.create-approved:${uuid}`),
        routineId,
        botId,
        targetThreadId: threadId,
        job: input.name,
        procedure: input.instructions,
        schedule: input.schedule,
        timezone: decodedTimezone,
        skillAssignmentIds,
        connectorDependencies,
        projectId: thread.projectId,
        sandbox: "local",
        approvalPolicy: thread.runtimeMode,
        createdAt: now,
      });
      return { routineId, sequence: result.sequence, status: "approved" as const };
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(RoutineDraftError)(cause)
          ? cause
          : fail(cause instanceof Error ? cause.message : String(cause)),
      ),
    );

  const listForThread: RoutineDraftDispatcherShape["listForThread"] = (threadId) =>
    Effect.gen(function* () {
      const thread = Option.getOrUndefined(yield* snapshots.getThreadDetailById(threadId));
      if (!thread || thread.archivedAt !== null) {
        return yield* fail("The current chat is unavailable.");
      }
      const botId = thread.respondingBotId ?? thread.botId;
      if (botId === null || botId === undefined) {
        return yield* fail("Routines can only be inspected from a bot chat.");
      }
      const snapshot = yield* snapshots.getShellSnapshot();
      const bot = snapshot.bots.find(
        (candidate) => candidate.id === botId && candidate.archivedAt === null,
      );
      if (!bot) return yield* fail("The current bot is unavailable.");
      return routineStatusesForBot(snapshot.routines ?? [], botId);
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(RoutineDraftError)(cause)
          ? cause
          : fail(cause instanceof Error ? cause.message : String(cause)),
      ),
    );

  const deleteForThread: RoutineDraftDispatcherShape["deleteForThread"] = (threadId, routineIds) =>
    Effect.gen(function* () {
      const thread = Option.getOrUndefined(yield* snapshots.getThreadDetailById(threadId));
      if (!thread || thread.archivedAt !== null) {
        return yield* fail("The current chat is unavailable.");
      }
      const botId = thread.respondingBotId ?? thread.botId;
      if (botId === null || botId === undefined) {
        return yield* fail("Routines can only be deleted from a bot chat.");
      }
      const snapshot = yield* snapshots.getShellSnapshot();
      const bot = snapshot.bots.find(
        (candidate) => candidate.id === botId && candidate.archivedAt === null,
      );
      if (!bot) return yield* fail("The current bot is unavailable.");

      const uniqueRoutineIds = [...new Set(routineIds)];
      if (uniqueRoutineIds.length === 0) {
        return yield* fail("Select at least one routine to delete.");
      }
      const availableRoutineIds = new Set(
        routineStatusesForBot(snapshot.routines ?? [], botId).map((routine) => routine.id),
      );
      if (uniqueRoutineIds.some((routineId) => !availableRoutineIds.has(routineId))) {
        return yield* fail("One or more routines are unavailable.");
      }

      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const results = yield* Effect.forEach(uniqueRoutineIds, (routineId) =>
        Effect.gen(function* () {
          const uuid = yield* crypto.randomUUIDv4;
          return yield* engine.dispatch({
            type: "routine.delete",
            commandId: CommandId.make(`agent:routine.delete:${uuid}`),
            routineId,
            createdAt,
          });
        }),
      );
      return {
        routineIds: uniqueRoutineIds,
        sequences: results.map((result) => result.sequence),
        status: "deleted" as const,
      };
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(RoutineDraftError)(cause)
          ? cause
          : fail(cause instanceof Error ? cause.message : String(cause)),
      ),
    );

  return {
    createApprovedForThread,
    listForThread,
    deleteForThread,
  } satisfies RoutineDraftDispatcherShape;
});

export const RoutineDraftDispatcherLive = Layer.effect(RoutineDraftDispatcher, make);
