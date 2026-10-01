import { type OrchestrationEvent, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionBotRepository } from "../../persistence/Services/ProjectionBots.ts";
import { ProjectionGroupRepository } from "../../persistence/Services/ProjectionGroups.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionMcpServerRepository } from "../../persistence/Services/ProjectionMcpServers.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionBotRepositoryLive } from "../../persistence/Layers/ProjectionBots.ts";
import { ProjectionGroupRepositoryLive } from "../../persistence/Layers/ProjectionGroups.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionMcpServerRepositoryLive } from "../../persistence/Layers/ProjectionMcpServers.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  type ProjectorDefinition,
  ORCHESTRATION_PROJECTOR_NAMES,
  projectorEventTypes,
  type AttachmentSideEffects,
} from "./projection/Definitions.ts";
import {
  runAttachmentSideEffects,
  collectThreadAttachmentRelativePaths,
} from "./projection/AttachmentCleanup.ts";
import { createProjects } from "./projection/Projects.ts";
import { createBots } from "./projection/Bots.ts";
import { createGroups } from "./projection/Groups.ts";
import { createDelegations } from "./projection/Delegations.ts";
import { createRoutines } from "./projection/Routines.ts";
import { createMcpServers } from "./projection/McpServers.ts";
import { createThreads } from "./projection/Threads.ts";
import { createMessages } from "./projection/Messages.ts";
import { createRequests } from "./projection/Requests.ts";
import { createTurns } from "./projection/Turns.ts";

export { ORCHESTRATION_PROJECTOR_NAMES } from "./projection/Definitions.ts";

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionBotRepository = yield* ProjectionBotRepository;
    const projectionGroupRepository = yield* ProjectionGroupRepository;
    const projectionMcpServerRepository = yield* ProjectionMcpServerRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const { applyProjectsProjection } = createProjects({ projectionProjectRepository });
    const { applyBotsProjection } = createBots({ projectionBotRepository });
    const { applyGroupsProjection } = createGroups({ projectionGroupRepository });
    const { applyDelegationsProjection, delegationParentLink } = createDelegations({ sql });
    const { applyRoutinesProjection } = createRoutines({ sql });
    const { applyMcpServersProjection } = createMcpServers({ projectionMcpServerRepository });

    const { applyThreadsProjection } = createThreads({
      projectionThreadRepository,
      projectionThreadMessageRepository,
      projectionThreadProposedPlanRepository,
      projectionThreadActivityRepository,
      projectionPendingApprovalRepository,
      delegationParentLink,
      eventStore,
      projectionTurnRepository,
    });

    const { applyThreadMessagesProjection, applyThreadProposedPlansProjection } = createMessages({
      projectionThreadMessageRepository,
      projectionTurnRepository,
      projectionThreadProposedPlanRepository,
    });

    const { applyThreadActivitiesProjection, applyPendingApprovalsProjection } = createRequests({
      projectionThreadActivityRepository,
      projectionTurnRepository,
      projectionPendingApprovalRepository,
    });

    const {
      applyThreadSessionsProjection,
      applyThreadTurnsProjection,
      applyCheckpointsProjection,
    } = createTurns({ projectionThreadSessionRepository, projectionTurnRepository });

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        eventTypes: projectorEventTypes([
          "project.created",
          "project.meta-updated",
          "project.deleted",
        ]),
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.bots,
        eventTypes: projectorEventTypes([
          "bot.created",
          "bot.updated",
          "bot.archived",
          "bot.restored",
          "bot.deleted",
        ]),
        apply: applyBotsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.groups,
        eventTypes: projectorEventTypes([
          "group.created",
          "group.renamed",
          "group.member-assigned",
          "group.member-unassigned",
          "group.person-assigned",
          "group.person-unassigned",
          "group.boss-set",
          "group.deleted",
        ]),
        apply: applyGroupsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.delegations,
        eventTypes: projectorEventTypes(["delegation.created", "delegation.updated"]),
        apply: applyDelegationsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.mcpServers,
        eventTypes: projectorEventTypes([
          "mcp-server.created",
          "mcp-server.updated",
          "mcp-server.enabled",
          "mcp-server.disabled",
          "mcp-server.deleted",
        ]),
        apply: applyMcpServersProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.routines,
        eventTypes: projectorEventTypes([
          "skill-assignment.assigned",
          "skill-assignment.unassigned",
          "routine.drafted",
          "routine.approved",
          "routine.enabled",
          "routine.running",
          "routine.paused",
          "routine.blocked",
          "routine.failed",
          "routine.completed",
          "routine.run-canceled",
          "routine.deleted",
        ]),
        apply: applyRoutinesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        eventTypes: projectorEventTypes([
          "thread.created",
          "thread.message-sent",
          "thread.channel-delivery-set",
          "thread.message-reaction-set",
          "thread.reverted",
        ]),
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        eventTypes: projectorEventTypes([
          "thread.created",
          "thread.proposed-plan-upserted",
          "thread.reverted",
        ]),
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        eventTypes: projectorEventTypes([
          "thread.created",
          "thread.activity-appended",
          "thread.reverted",
        ]),
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        eventTypes: projectorEventTypes([
          "thread.created",
          "thread.turn-resume-requested",
          "thread.session-set",
        ]),
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        eventTypes: projectorEventTypes([
          "thread.created",
          "thread.turn-start-requested",
          "thread.session-set",
          "thread.message-sent",
          "thread.turn-interrupt-requested",
          "thread.turn-diff-completed",
          "thread.reverted",
        ]),
        apply: applyThreadTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        eventTypes: projectorEventTypes([]),
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        eventTypes: projectorEventTypes([
          "thread.created",
          "thread.activity-appended",
          "thread.approval-response-requested",
        ]),
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        eventTypes: projectorEventTypes([
          "thread.created",
          "thread.ownership-updated",
          "thread.archived",
          "thread.unarchived",
          "thread.settled",
          "thread.unsettled",
          "thread.snoozed",
          "thread.unsnoozed",
          "thread.pinned",
          "thread.unpinned",
          "thread.pin-reordered",
          "thread.meta-updated",
          "thread.runtime-mode-set",
          "thread.interaction-mode-set",
          "thread.deleted",
          "thread.turn-start-requested",
          "thread.message-sent",
          "thread.message-reaction-set",
          "thread.proposed-plan-upserted",
          "thread.activity-appended",
          "thread.approval-response-requested",
          "thread.user-input-response-requested",
          "thread.session-set",
          "thread.turn-diff-completed",
          "thread.reverted",
        ]),
        apply: applyThreadsProjection,
      },
    ];

    const applyAttachmentSideEffects = Effect.fn("applyAttachmentSideEffects")(
      function* (event: OrchestrationEvent, sideEffects: AttachmentSideEffects) {
        if (
          sideEffects.deletedThreadIds.size === 0 &&
          sideEffects.prunedThreadRelativePaths.size === 0
        ) {
          return;
        }

        const deletedThreadIds = new Set<string>();

        for (const threadId of sideEffects.deletedThreadIds) {
          const recreatedLater = yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: ThreadId.make(threadId),
            type: "thread.created",
            sequenceExclusive: event.sequence,
          });

          if (!recreatedLater) {
            deletedThreadIds.add(threadId);
          }
        }

        // Later events in the same transaction can add attachment references.
        const prunedThreadRelativePaths = new Map<string, Set<string>>();

        for (const threadId of sideEffects.prunedThreadRelativePaths.keys()) {
          const messages = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: ThreadId.make(threadId),
          });

          prunedThreadRelativePaths.set(
            threadId,
            collectThreadAttachmentRelativePaths(threadId, messages),
          );
        }

        yield* runAttachmentSideEffects({ deletedThreadIds, prunedThreadRelativePaths });
      },
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      (effect, event) =>
        effect.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to apply projected attachment side-effects", {
              sequence: event.sequence,
              eventType: event.type,
              cause,
            }),
          ),
        ),
    );

    const projectorHandlesEvent = (projector: ProjectorDefinition, event: OrchestrationEvent) =>
      projector.eventTypes === undefined || projector.eventTypes.has(event.type);

    const applyProjectorForEvent = Effect.fn("applyProjectorForEvent")(function* (
      projector: ProjectorDefinition,
      event: OrchestrationEvent,
      attachmentSideEffects: AttachmentSideEffects,
    ) {
      if (projectorHandlesEvent(projector, event)) {
        yield* projector.apply(event, attachmentSideEffects);
      }

      yield* projectionStateRepository.upsert({
        projector: projector.name,
        lastAppliedSequence: event.sequence,
        updatedAt: event.occurredAt,
      });
    });

    const runProjectorForEvent = Effect.fn("runProjectorForEvent")(function* (
      projector: ProjectorDefinition,
      event: OrchestrationEvent,
    ) {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(applyProjectorForEvent(projector, event, attachmentSideEffects));
      yield* applyAttachmentSideEffects(event, attachmentSideEffects);
    });

    const bootstrapProjector = (projector: ProjectorDefinition) =>
      projectionStateRepository
        .getByProjector({
          projector: projector.name,
        })
        .pipe(
          Effect.flatMap((stateRow) =>
            Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
                Number.MAX_SAFE_INTEGER,
              ),
              (event) => runProjectorForEvent(projector, event),
            ),
          ),
        );

    const projectEventDeferred: OrchestrationProjectionPipelineShape["projectEventDeferred"] =
      Effect.fn("projectEventDeferred")(
        function* (event) {
          const attachmentSideEffects: AttachmentSideEffects = {
            deletedThreadIds: new Set<string>(),
            prunedThreadRelativePaths: new Map<string, Set<string>>(),
          };

          // Every cursor still advances to this event, so resume and snapshot
          // sequences match running each projector; only no-op applies are skipped.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              for (const projector of projectors) {
                if (projectorHandlesEvent(projector, event)) {
                  yield* projector.apply(event, attachmentSideEffects);
                }
              }

              yield* projectionStateRepository.upsertMany(
                projectors.map((projector) => ({
                  projector: projector.name,
                  lastAppliedSequence: event.sequence,
                  updatedAt: event.occurredAt,
                })),
              );
            }),
          );

          // Return the cleanup effect so the caller runs it after the outer transaction commits.
          return yield* Effect.succeed(applyAttachmentSideEffects(event, attachmentSideEffects));
        },
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = Effect.fn(
      "projectEvent",
    )(function* (event) {
      const cleanup = yield* projectEventDeferred(event);
      yield* cleanup;
    });

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
      projectors,
      bootstrapProjector,
      { concurrency: 1 },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    return {
      bootstrap,
      projectEvent,
      projectEventDeferred,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionBotRepositoryLive),
  Layer.provideMerge(ProjectionGroupRepositoryLive),
  Layer.provideMerge(ProjectionMcpServerRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
