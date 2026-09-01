import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  IsoDateTime,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  PositiveInt,
  ProjectId,
  ProviderInstanceId,
  RoutineId,
  RoutineTimeZone,
  ThreadId,
  type Routine,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RoutineDraftDispatcher,
  RoutineDraftDispatcherLive,
  routineStatusesForBot,
} from "./RoutineDraftDispatcher.ts";

const botId = BotId.make("bot-1");
const otherBotId = BotId.make("bot-2");
const now = IsoDateTime.make("2026-09-01T09:00:00.000Z");

function bot(id: BotId): OrchestrationBot {
  return {
    id,
    name: id,
    title: "Agent",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "dither", seed: id },
    engine: null,
    sandbox: "local",
    runtimeMode: "full-access",
    usageCap: null,
    voiceEnabled: false,
    channelBindings: [],
    groupId: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function routine(id: string, overrides: Partial<Routine> = {}): Routine {
  return {
    id: RoutineId.make(id),
    botId,
    targetThreadId: ThreadId.make("thread-1"),
    job: `Routine ${id}`,
    procedure: "Reply in this chat.",
    schedule: { kind: "daily", time: "09:00" },
    timezone: RoutineTimeZone.make("America/New_York"),
    skillAssignmentIds: [],
    connectorDependencies: [],
    projectId: ProjectId.make("project-1"),
    sandbox: "local",
    approvalPolicy: "approval-required",
    procedureVersion: PositiveInt.make(1),
    approvalVersion: PositiveInt.make(1),
    enabled: false,
    lifecycle: "approved",
    nextRunAt: null,
    lastRunAt: null,
    latestResult: null,
    latestFailure: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

describe("routineStatusesForBot", () => {
  it("returns only active routines owned by the current bot", () => {
    expect(
      routineStatusesForBot(
        [
          routine("enabled", { enabled: true, lifecycle: "enabled" }),
          routine("disabled"),
          routine("blocked", { lifecycle: "blocked" }),
          routine("other-bot", { botId: otherBotId, enabled: true, lifecycle: "enabled" }),
          routine("deleted", {
            lifecycle: "deleted",
            deletedAt: IsoDateTime.make("2026-09-01T10:00:00.000Z"),
          }),
        ],
        botId,
      ),
    ).toEqual([
      { id: "enabled", name: "Routine enabled", enabled: true, lifecycle: "enabled" },
      { id: "disabled", name: "Routine disabled", enabled: false, lifecycle: "approved" },
      { id: "blocked", name: "Routine blocked", enabled: false, lifecycle: "blocked" },
    ]);
  });
});

function deleteHarness(input: {
  readonly routines: ReadonlyArray<Routine>;
  readonly respondingBotId?: BotId | null;
}) {
  const commands: Array<OrchestrationCommand> = [];
  const thread: OrchestrationThread = {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    botId,
    groupId: null,
    respondingBotId: input.respondingBotId ?? null,
    title: "Routine thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: [],
    bots: [bot(botId), bot(otherBotId)],
    groups: [],
    delegations: [],
    routines: input.routines,
    threads: [],
    updatedAt: now,
  };
  const query: ProjectionSnapshotQueryShape = {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.succeed(Option.some(thread)),
    getShellSnapshot: () => Effect.succeed(snapshot),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.succeed({ matches: [] }),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 1 }),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getOriginalProjectIdByWorkspaceRoot: () => Effect.succeed(Option.none()),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    getThreadCheckpointContext: () => Effect.succeed(Option.none()),
    getFullThreadDiffContext: () => Effect.succeed(Option.none()),
    getThreadShellById: () => Effect.succeed(Option.none()),
    getThreadDetailSnapshot: () => Effect.die("unused"),
  };
  const layer = RoutineDraftDispatcherLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProjectionSnapshotQuery, query),
        Layer.succeed(OrchestrationEngineService, {
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: commands.length };
            }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { commands, layer };
}

describe("RoutineDraftDispatcher.deleteForThread", () => {
  it.effect("validates the full batch before dispatching scoped delete commands", () => {
    const test = deleteHarness({
      routines: [routine("owned"), routine("other", { botId: otherBotId })],
    });

    return Effect.gen(function* () {
      const dispatcher = yield* RoutineDraftDispatcher;
      const error = yield* dispatcher
        .deleteForThread(ThreadId.make("thread-1"), [
          RoutineId.make("owned"),
          RoutineId.make("other"),
        ])
        .pipe(Effect.flip);

      expect(error.message).toBe("One or more routines are unavailable.");
      expect(test.commands).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("deletes each unique routine owned by the responding bot", () => {
    const test = deleteHarness({
      respondingBotId: otherBotId,
      routines: [
        routine("primary"),
        routine("first", { botId: otherBotId }),
        routine("second", { botId: otherBotId }),
      ],
    });

    return Effect.gen(function* () {
      const dispatcher = yield* RoutineDraftDispatcher;
      const result = yield* dispatcher.deleteForThread(ThreadId.make("thread-1"), [
        RoutineId.make("first"),
        RoutineId.make("second"),
        RoutineId.make("first"),
      ]);

      expect(result).toEqual({
        routineIds: ["first", "second"],
        sequences: [1, 2],
        status: "deleted",
      });
      expect(test.commands).toHaveLength(2);
      expect(test.commands.map(({ type }) => type)).toEqual(["routine.delete", "routine.delete"]);
      expect(
        test.commands.map((command) => command.type === "routine.delete" && command.routineId),
      ).toEqual(["first", "second"]);
      expect(
        test.commands.every(
          (command) =>
            command.type === "routine.delete" &&
            command.commandId.startsWith("agent:routine.delete:"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(test.layer));
  });
});
