import {
  BotId,
  CommandId,
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

export interface RoutineDraftResult {
  readonly routineId: RoutineId;
  readonly sequence: number;
  readonly status: "drafted";
}

export class RoutineDraftError extends Schema.TaggedErrorClass<RoutineDraftError>()(
  "RoutineDraftError",
  { message: Schema.String },
) {}

export interface RoutineDraftDispatcherShape {
  readonly draftForThread: (
    threadId: ThreadId,
    timezone: string,
    input: AkeruCreateRoutineInput,
  ) => Effect.Effect<RoutineDraftResult, RoutineDraftError>;
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

  const draftForThread: RoutineDraftDispatcherShape["draftForThread"] = (
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
        type: "routine.draft",
        commandId: CommandId.make(`agent:routine.draft:${uuid}`),
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
      return { routineId, sequence: result.sequence, status: "drafted" as const };
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(RoutineDraftError)(cause)
          ? cause
          : fail(cause instanceof Error ? cause.message : String(cause)),
      ),
    );

  return { draftForThread } satisfies RoutineDraftDispatcherShape;
});

export const RoutineDraftDispatcherLive = Layer.effect(RoutineDraftDispatcher, make);
