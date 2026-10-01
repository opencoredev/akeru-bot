import * as Schema from "effect/Schema";

export const failureInjection = {
  failResolvedActivityOnce: false,
  crashAfterScopedFactOnce: false,
  crashAfterRetractOnce: false,
};

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY,
  AkeruMemoryTenantId,
  AkeruMemoryUserId,
  BotId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { BotInboxService } from "../../bot-inbox/service.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationListenerCallbackError } from "../../orchestration/Errors.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { EntityMemoryRepositoryLive } from "../Layers/EntityMemoryRepository.ts";
import { MemoryApprovalsLive } from "../MemoryApprovals.ts";
import { EntityMemoryRepository } from "../Services/EntityMemoryRepository.ts";
import { MemoryRevisionWriteLockLive } from "../Services/MemoryRevisionWriteLock.ts";

const botId = BotId.make("bot-ada");

const threadId = ThreadId.make("thread-ada");

const access = {
  tenantId: AkeruMemoryTenantId.make("tenant"),
  userId: AkeruMemoryUserId.make("user"),
  threadId,
  projectId: ProjectId.make("project"),
  workspaceRoot: "/workspace",
  legacyWorkspaceOwnerProjectId: ProjectId.make("project"),
  botId,
  groupId: null,
  respondingBotId: null,
  groupMemberBotIds: [],
} as const;

const dispatched: Array<OrchestrationCommand> = [];

const engineLayer = Layer.succeed(OrchestrationEngineService, {
  dispatch: (command) =>
    Effect.suspend(() => {
      if (
        failureInjection.failResolvedActivityOnce &&
        command.type === "thread.activity.append" &&
        command.activity.kind === AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY
      ) {
        failureInjection.failResolvedActivityOnce = false;

        return Effect.fail(
          new OrchestrationListenerCallbackError({
            listener: "read-model",
            detail: "simulated activity failure",
          }),
        );
      }

      return Effect.sync(() => {
        dispatched.push(command);

        return { sequence: dispatched.length };
      });
    }),
  readEvents: () => Stream.empty,
  readThreadEvents: () => Stream.empty,
  getThreadReplayStats: () => Effect.die("unused"),
  streamDomainEvents: Stream.empty,
  subscribeDomainEvents: Effect.succeed(Stream.empty),
  latestSequence: Effect.succeed(0),
});

// Only the two reads MemoryApprovals uses to label inbox items are real.
const decodeThread = Schema.decodeUnknownSync(OrchestrationThreadShell);

const decodeShell = Schema.decodeUnknownSync(OrchestrationShellSnapshot);

const snapshotQuery = {
  getThreadShellById: (id: ThreadId) =>
    Effect.succeed(
      id === threadId
        ? Option.some(
            decodeThread({
              projectId: "project",
              modelSelection: { instanceId: "codex", model: "gpt" },
              runtimeMode: "approval-required",
              branch: null,
              worktreePath: null,
              latestTurn: null,
              createdAt: "2026-08-31T20:00:00.000Z",
              updatedAt: "2026-08-31T20:00:00.000Z",
              session: null,
              latestUserMessageAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
              id,
              title: "Release notes",
              botId,
              respondingBotId: null,
            }),
          )
        : Option.none(),
    ),
  getShellSnapshot: () =>
    Effect.succeed(
      decodeShell({
        snapshotSequence: 0,
        projects: [],
        threads: [],
        updatedAt: "2026-08-31T20:00:00.000Z",
        bots: [
          {
            id: botId,
            name: "Ada",
            title: "Assistant",
            avatar: { kind: "blob", shape: "circle", color: "blue" },
            engine: null,
            sandbox: "local",
            groupId: null,
            archivedAt: null,
            createdAt: "2026-08-31T20:00:00.000Z",
            updatedAt: "2026-08-31T20:00:00.000Z",
          },
        ],
      }),
    ),
} satisfies Partial<ProjectionSnapshotQueryShape>;

const repositoryLayer = EntityMemoryRepositoryLive.pipe(Layer.provide(MemoryRevisionWriteLockLive));

const crashInjectingRepositoryLayer = Layer.effect(
  EntityMemoryRepository,
  Effect.gen(function* () {
    const repository = yield* EntityMemoryRepository;

    return {
      ...repository,
      insertScopedFact: (input: Parameters<typeof repository.insertScopedFact>[0]) =>
        repository.insertScopedFact(input).pipe(
          Effect.tap(() =>
            failureInjection.crashAfterScopedFactOnce
              ? Effect.sync(() => {
                  failureInjection.crashAfterScopedFactOnce = false;
                  throw new Error("simulated crash after scoped fact write");
                })
              : Effect.void,
          ),
        ),
      applyMutation: (input: Parameters<typeof repository.applyMutation>[0]) =>
        repository.applyMutation(input).pipe(
          Effect.tap(() =>
            failureInjection.crashAfterRetractOnce
              ? Effect.sync(() => {
                  failureInjection.crashAfterRetractOnce = false;
                  throw new Error("simulated crash after retract");
                })
              : Effect.void,
          ),
        ),
    };
  }),
).pipe(Layer.provide(repositoryLayer));

const testLayer = MemoryApprovalsLive.pipe(
  Layer.provideMerge(crashInjectingRepositoryLayer),
  Layer.provideMerge(engineLayer),
  Layer.provideMerge(Layer.mock(ProjectionSnapshotQuery)(snapshotQuery)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "akeru-memory-approvals-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(NodeServices.layer),
);

const inbox = Effect.map(ServerConfig, (config) =>
  BotInboxService.forSecretsDir(config.secretsDir),
);

const activityKinds = () =>
  dispatched.flatMap((command) =>
    command.type === "thread.activity.append" ? [command.activity.kind] : [],
  );

export {
  botId,
  threadId,
  access,
  dispatched,
  engineLayer,
  snapshotQuery,
  repositoryLayer,
  crashInjectingRepositoryLayer,
  testLayer,
  inbox,
  activityKinds,
};
