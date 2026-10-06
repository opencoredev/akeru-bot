import { type OrchestrationEvent } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { createDependencies } from "./provider-command/Dependencies.ts";
import { createWorkspace } from "./provider-command/Workspace.ts";
import { createContext } from "./provider-command/Context.ts";
import { createMentions } from "./provider-command/Mentions.ts";
import { createTitles } from "./provider-command/Titles.ts";
import { createDelegations } from "./provider-command/Delegations.ts";
import { createFailures } from "./provider-command/Failures.ts";
import { createSession } from "./provider-command/Session.ts";
import { createTurns } from "./provider-command/Turns.ts";
import { createRequests } from "./provider-command/Requests.ts";
import { createRouting } from "./provider-command/Routing.ts";
import { createRecovery } from "./provider-command/Recovery.ts";

export {
  type KeyedDrainableWorker,
  keyedDrainableWorker,
} from "./provider-command/KeyedDrainableWorker.ts";

export {
  type ControllerThreadIdentity,
  type ControllerEngineThread,
  resolveControllerBotId,
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
} from "./provider-command/Fields.ts";

const make = Effect.gen(function* () {
  const {
    orchestrationEngine,
    projectionSnapshotQuery,
    projectionBotRepository,
    projectionMcpServerRepository,
    agentController,
    providerSessionDirectory,
    providerRegistry,
    gitWorkflow,
    fileSystem,
    textGeneration,
    serverSettingsService,
    botUsageLedger,
    composio,
    serverCommandId,
    serverEventId,
    hasHandledTurnRequestRecently,
    threadModelSelections,
    threadBotWorkspaceKeys,
    threadMcpServers,
    threadsAwaitingRestrictiveSessionCleanup,
  } = yield* createDependencies();

  const { resolveProject, ensureThreadWorktree, maybeGenerateAndRenameWorktreeBranchForFirstTurn } =
    createWorkspace({
      projectionSnapshotQuery,
      fileSystem,
      gitWorkflow,
      serverSettingsService,
      textGeneration,
      orchestrationEngine,
      serverCommandId,
    });

  const {
    resolveThreadShell,
    resolveThreadDetail,
    inspectAvailableEngine,
    resolveControllerEngine,
    resolveControllerMcpServers,
    rejectStartedThreadModelChangeIfRequired,
  } = createContext({
    projectionSnapshotQuery,
    agentController,
    projectionBotRepository,
    projectionMcpServerRepository,
    composio,
    providerRegistry,
  });

  const { expandComposerMentions } = createMentions({
    serverSettingsService,
    projectionSnapshotQuery,
  });

  const {
    findInterruptedThreadTitleRegenerations,
    clearInterruptedThreadTitleRegenerations,
    threadTitleRegenerationWorker,
  } = yield* createTitles({
    resolveProject,
    serverSettingsService,
    textGeneration,
    resolveThreadShell,
    orchestrationEngine,
    serverCommandId,
    projectionSnapshotQuery,
  });

  const { dispatchDelegationRelease, releaseDelegationResults, readDelegationResults } =
    createDelegations({ serverCommandId, orchestrationEngine, projectionSnapshotQuery });

  const {
    failDelegation,
    failDelegationStart,
    appendProviderFailureActivity,
    appendUserInputFailureReply,
    appendApprovalFailureReply,
    formatFailureDetail,
    formatFailure,
    setThreadSession,
    setThreadSessionErrorOnTurnStartFailure,
  } = createFailures({
    agentController,
    projectionBotRepository,
    serverCommandId,
    serverEventId,
    orchestrationEngine,
    resolveThreadDetail,
    resolveThreadShell,
  });

  const {
    reconcileRestrictiveSessionCleanup,
    ensureSessionForThread,
    buildSendTurnRequestForThread,
  } = createSession({
    resolveThreadShell,
    threadsAwaitingRestrictiveSessionCleanup,
    agentController,
    resolveControllerEngine,
    inspectAvailableEngine,
    setThreadSession,
    rejectStartedThreadModelChangeIfRequired,
    resolveProject,
    projectionSnapshotQuery,
    resolveControllerMcpServers,
    serverSettingsService,
    projectionBotRepository,
    threadModelSelections,
    threadMcpServers,
    threadBotWorkspaceKeys,
    providerSessionDirectory,
    expandComposerMentions,
  });

  const {
    processTurnStartRequested,
    processTurnInterruptRequested,
    resumeInterruptedTurn,
    processTurnResumeRequested,
    processSessionStopRequested,
  } = createTurns({
    hasHandledTurnRequestRecently,
    resolveThreadShell,
    projectionSnapshotQuery,
    appendProviderFailureActivity,
    failDelegation,
    ensureThreadWorktree,
    maybeGenerateAndRenameWorktreeBranchForFirstTurn,
    formatFailure,
    setThreadSessionErrorOnTurnStartFailure,
    failDelegationStart,
    releaseDelegationResults,
    projectionBotRepository,
    botUsageLedger,
    buildSendTurnRequestForThread,
    readDelegationResults,
    agentController,
    formatFailureDetail,
    setThreadSession,
  });

  const { processApprovalResponseRequested, processUserInputResponseRequested } = createRequests({
    resolveThreadShell,
    appendProviderFailureActivity,
    appendApprovalFailureReply,
    agentController,
    formatFailureDetail,
    setThreadSession,
    appendUserInputFailureReply,
  });

  const { worker, enqueueProviderCommand } = yield* createRouting({
    agentController,
    appendProviderFailureActivity,
    threadTitleRegenerationWorker,
    resolveThreadShell,
    threadModelSelections,
    ensureSessionForThread,
    formatFailureDetail,
    threadsAwaitingRestrictiveSessionCleanup,
    setThreadSessionErrorOnTurnStartFailure,
    reconcileRestrictiveSessionCleanup,
    processTurnStartRequested,
    processTurnResumeRequested,
    processTurnInterruptRequested,
    processApprovalResponseRequested,
    processUserInputResponseRequested,
    processSessionStopRequested,
  });

  const { recoverStartupProviderWork } = createRecovery({
    orchestrationEngine,
    serverEventId,
    projectionSnapshotQuery,
    dispatchDelegationRelease,
    enqueueProviderCommand,
    worker,
    agentController,
    resumeInterruptedTurn,
    setThreadSessionErrorOnTurnStartFailure,
    formatFailureDetail,
  });

  // Highest event sequence the subscriber has handed to the worker, so drain
  // can wait for published events that are still in the subscription buffer.
  const seenSequence = yield* SubscriptionRef.make(0);

  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const started = yield* SubscriptionRef.make(false);

  // Subscribes before returning and yields every event after the baseline once.
  // Events committed between the first sequence read and the subscription may
  // have been published before it existed, so that gap is read from the store
  // before start returns and the live stream skips everything it covered. A
  // store that cannot replay the gap fails startup rather than drop intents.
  const subscribeWithBaseline = Effect.fn("subscribeWithBaseline")(function* () {
    const baselineSequence = yield* orchestrationEngine.latestSequence;
    const liveEvents = yield* orchestrationEngine.subscribeDomainEvents;
    const replayThrough = yield* orchestrationEngine.latestSequence;

    if (replayThrough === baselineSequence) {
      return { domainEvents: liveEvents, baselineSequence };
    }

    const gapEvents = yield* Stream.runCollect(
      orchestrationEngine.readEvents(
        baselineSequence,
        replayThrough - baselineSequence,
        replayThrough,
      ),
    ).pipe(
      Effect.retry(Schedule.max([Schedule.exponential("100 millis"), Schedule.recurs(3)])),
      Effect.orDie,
    );

    return {
      domainEvents: Stream.fromIterable(gapEvents).pipe(
        Stream.concat(liveEvents.pipe(Stream.filter((event) => event.sequence > replayThrough))),
      ),
      baselineSequence,
    };
  });

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    yield* SubscriptionRef.set(started, true);

    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }

        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );

    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      yield* enqueueProviderIntent(event);
      yield* noteSeen(event.sequence);
    });

    const enqueueProviderIntent = Effect.fn("enqueueProviderIntent")(function* (
      event: OrchestrationEvent,
    ) {
      if (
        (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-resume-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "delegation.updated" ||
        event.type === "delegation.retry-requested"
      ) {
        yield* enqueueProviderCommand(event);
      }
    });

    // Subscribe before returning, even while event handling waits for server activation.
    const { domainEvents, baselineSequence } = yield* subscribeWithBaseline();
    yield* noteSeen(baselineSequence);
    yield* forkParked(Stream.runForEach(domainEvents, processEvent));

    yield* recoverStartupProviderWork().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("provider command reactor startup recovery failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );

    // Correlated completions only clear the request captured here, leaving any
    // newer request untouched.
    const clearInterrupted = clearInterruptedThreadTitleRegenerations(
      interruptedTitleRegenerations,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }

        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );

    const activation = yield* ServerActivation;

    if (activation === undefined) {
      yield* clearInterrupted;
    } else {
      yield* forkParked(clearInterrupted);
    }
  });

  return {
    start,
    // Waits until the subscriber has taken every event published so far, then
    // until both workers are idle. Repeats while that work publishes more events.
    drain: Effect.gen(function* () {
      while (true) {
        const target = (yield* SubscriptionRef.get(started))
          ? yield* orchestrationEngine.latestSequence
          : 0;

        yield* SubscriptionRef.changes(seenSequence).pipe(
          Stream.filter((seen) => seen >= target),
          Stream.runHead,
        );
        yield* worker.drain;
        yield* threadTitleRegenerationWorker.drain;

        if (target === 0 || (yield* orchestrationEngine.latestSequence) === target) return;
      }
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
