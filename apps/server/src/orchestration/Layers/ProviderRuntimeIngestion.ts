import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@akeru/shared/DrainableWorker";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  type ChannelSessionDomainEvent,
  type RuntimeIngestionInput,
} from "./runtime-ingestion/EventFields.ts";
import { createDependencies } from "./runtime-ingestion/Dependencies.ts";
import { createChannels } from "./runtime-ingestion/Channels.ts";
import { createWatchdogs } from "./runtime-ingestion/Watchdogs.ts";
import { createContext } from "./runtime-ingestion/Context.ts";
import { createMessages } from "./runtime-ingestion/Messages.ts";
import { createPlans } from "./runtime-ingestion/Plans.ts";
import { createTasks } from "./runtime-ingestion/Tasks.ts";
import { createCleanup } from "./runtime-ingestion/Cleanup.ts";
import { createAdmission } from "./runtime-ingestion/Admission.ts";
import { createEvents } from "./runtime-ingestion/Events.ts";
export { runtimeEventToActivities } from "./runtime-ingestion/ActivityMapping.ts";
export { findTaskTitleInActivities } from "./runtime-ingestion/EventFields.ts";

const make = Effect.gen(function* () {
  const {
    threadBackgroundLiveness,
    threadPlanProgress,
    crypto,
    orchestrationEngine,
    projectionSnapshotQuery,
    agentController,
    checkpointStore,
    projectionTurnRepository,
    projectionThreadMessages,
    projectionThreadActivities,
    projectionThreadProposedPlans,
    botUsageLedger,
    serverSettingsService,
    channelRuntime,
    botInbox,
  } = yield* createDependencies();
  const {
    channelStatusWorker,
    automaticChannelReplyWorker,
    channelWaitingRequests,
    clearChannelWaitingRequests,
  } = yield* createChannels({ channelRuntime });
  const {
    silenceWatchdogs,
    silenceWaitingRequests,
    stopSilenceWatchdog,
    stopAllSilenceWatchdogs,
    silenceReportWorker,
    resolveSilenceIncidents,
    startTurnSilenceWatchdog,
  } = yield* createWatchdogs({ botInbox, orchestrationEngine, projectionSnapshotQuery });
  const {
    providerCommandId,
    resolveNativeUserInputForTerminalTurn,
    resolveThreadDetail,
    deltaRuntimeContextByThread,
    resolveThreadRuntimeContextForEvent,
    getThreadMessageById,
    syncApprovalInbox,
  } = createContext({
    crypto,
    projectionThreadActivities,
    orchestrationEngine,
    projectionSnapshotQuery,
    projectionThreadMessages,
    botInbox,
  });
  const {
    turnMessageIdsByTurnKey,
    assistantSegmentStateByTurnKey,
    rememberAssistantMessageId,
    forgetAssistantMessageId,
    getAssistantMessageIdsForTurn,
    clearAssistantMessageIdsForTurn,
    clearAssistantSegmentStateForTurn,
    getActiveAssistantMessageIdForTurn,
    getOrCreateAssistantMessageId,
    appendBufferedAssistantText,
    clearAssistantMessageState,
    flushBufferedAssistantMessagesForTurn,
    finalizeAssistantMessage,
    finalizeActiveAssistantSegmentForTurn,
  } = yield* createMessages({ orchestrationEngine, providerCommandId });
  const {
    bufferedProposedPlanById,
    appendBufferedProposedPlan,
    finalizeBufferedProposedPlan,
    getExpectedProviderTurnIdForThread,
    getSourceProposedPlanReferenceForAcceptedTurnStart,
    markSourceProposedPlanImplemented,
  } = yield* createPlans({
    projectionThreadProposedPlans,
    orchestrationEngine,
    providerCommandId,
    projectionTurnRepository,
    agentController,
    resolveThreadDetail,
    crypto,
  });
  const { taskDescriptionByTaskKey, rememberTaskDescription, lookupTaskDescription } =
    yield* createTasks();
  const { clearTurnStateForSession } = createCleanup({
    turnMessageIdsByTurnKey,
    assistantSegmentStateByTurnKey,
    bufferedProposedPlanById,
    taskDescriptionByTaskKey,
    clearAssistantMessageState,
  });
  const { prepareRuntimeEvent } = createAdmission({
    resolveThreadRuntimeContextForEvent,
    silenceWatchdogs,
    syncApprovalInbox,
    stopAllSilenceWatchdogs,
    resolveSilenceIncidents,
    stopSilenceWatchdog,
    silenceWaitingRequests,
    channelRuntime,
    channelWaitingRequests,
    channelStatusWorker,
    clearChannelWaitingRequests,
    projectionTurnRepository,
    getExpectedProviderTurnIdForThread,
    botUsageLedger,
    startTurnSilenceWatchdog,
    getSourceProposedPlanReferenceForAcceptedTurnStart,
    markSourceProposedPlanImplemented,
    orchestrationEngine,
    providerCommandId,
  });
  const { processRuntimeEvent } = createEvents({
    prepareRuntimeEvent,
    getOrCreateAssistantMessageId,
    rememberAssistantMessageId,
    serverSettingsService,
    appendBufferedAssistantText,
    orchestrationEngine,
    providerCommandId,
    flushBufferedAssistantMessagesForTurn,
    finalizeActiveAssistantSegmentForTurn,
    projectionThreadMessages,
    appendBufferedProposedPlan,
    getActiveAssistantMessageIdForTurn,
    getThreadMessageById,
    finalizeAssistantMessage,
    forgetAssistantMessageId,
    clearAssistantSegmentStateForTurn,
    finalizeBufferedProposedPlan,
    resolveNativeUserInputForTerminalTurn,
    getAssistantMessageIdsForTurn,
    clearAssistantMessageIdsForTurn,
    clearTurnStateForSession,
    projectionSnapshotQuery,
    checkpointStore,
    rememberTaskDescription,
    threadPlanProgress,
    threadBackgroundLiveness,
    lookupTaskDescription,
    projectionThreadActivities,
    channelWaitingRequests,
    channelStatusWorker,
    channelRuntime,
    automaticChannelReplyWorker,
  });
  const processDomainEvent = Effect.fn("ProviderRuntimeIngestion.processChannelSession")(function* (
    event: ChannelSessionDomainEvent,
  ) {
    const { session, threadId } = event.payload;
    if (!channelRuntime || (session.status !== "error" && session.status !== "stopped")) return;
    const thread = yield* resolveThreadDetail(threadId);
    if (
      thread?.session?.updatedAt !== session.updatedAt ||
      thread.session.status !== session.status
    )
      return;
    clearChannelWaitingRequests(threadId);
    const request = thread.messages.findLast((message) => message.role === "user");
    if (!request?.channelOrigin) return;
    yield* channelStatusWorker.enqueue({
      threadId,
      turnId: undefined,
      requestMessageId: request.id,
      state: session.status === "error" ? "failed" : "cancelled",
    });
  });

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ProviderRuntimeIngestionShape["start"] = () =>
    Effect.gen(function* () {
      yield* forkParked(
        Stream.runForEach(agentController.streamEvents, (event) =>
          worker.enqueue({ source: "runtime", event }),
        ),
      );
      yield* forkParked(
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (event.type === "thread.deleted" || event.type === "thread.archived") {
            deltaRuntimeContextByThread.delete(String(event.payload.threadId));
          }
          if (event.type !== "thread.session-set") {
            return Effect.void;
          }
          deltaRuntimeContextByThread.delete(String(event.payload.threadId));
          return worker.enqueue({ source: "domain", event });
        }),
      );
    });

  return {
    start,
    drain: worker.drain.pipe(
      Effect.andThen(silenceReportWorker.drain),
      Effect.andThen(worker.drain),
      Effect.andThen(channelStatusWorker.drain),
      Effect.andThen(automaticChannelReplyWorker.drain),
    ),
  } satisfies ProviderRuntimeIngestionShape;
});
export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make,
).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provide(ProjectionThreadMessageRepositoryLive),
  Layer.provide(ProjectionThreadActivityRepositoryLive),
  Layer.provide(ProjectionThreadProposedPlanRepositoryLive),
);
