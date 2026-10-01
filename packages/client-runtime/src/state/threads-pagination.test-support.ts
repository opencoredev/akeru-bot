import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { TEST_SERVER_CONFIG, testRpcClient } from "../test-support/services.ts";
import {
  EnvironmentId,
  EventId,
  MessageId,
  CheckpointRef,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { ThreadSnapshotWindow } from "./threadSnapshotHttp.ts";
import {
  environmentThreadState,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "./threads.ts";

export const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

export const THREAD_ID = ThreadId.make("thread-1");

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

function message(id: string, turnId: string, createdAt: string): OrchestrationMessage {
  return {
    id: MessageId.make(id),
    role: "assistant",
    text: `text of ${id}`,
    turnId: TurnId.make(turnId),
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

const OLDER_MESSAGE = message("message-old", "turn-1", "2026-04-01T00:00:00.000Z");

const RECENT_MESSAGE = message("message-recent", "turn-2", "2026-04-01T01:00:00.000Z");

// Reverts retain turns via checkpoints with checkpointTurnCount <= the revert's
// turnCount, so both fixture turns carry one: reverting to turnCount 1 keeps
// turn-1 (the older page's turn) and discards turn-2 (the loaded window's).
function checkpoint(turnId: string, turnCount: number): OrchestrationThread["checkpoints"][number] {
  return {
    turnId: TurnId.make(turnId),
    checkpointTurnCount: turnCount,
    checkpointRef: CheckpointRef.make(`checkpoint-${turnCount}`),
    status: "ready",
    files: [],
    assistantMessageId: null,
    completedAt: "2026-04-01T01:00:00.000Z",
  };
}

export const BASE_THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Windowed thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [RECENT_MESSAGE],
  proposedPlans: [],
  activities: [],
  checkpoints: [checkpoint("turn-2", 2)],
  session: null,
};

export const WINDOWED_SNAPSHOT: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 10,
  thread: BASE_THREAD,
  page: { beforeCursor: "cursor-1", hasMore: true, snapshotSequence: 10 },
};

export const OLDER_PAGE: OrchestrationThreadDetailSnapshot = {
  snapshotSequence: 10,
  thread: {
    ...BASE_THREAD,
    messages: [OLDER_MESSAGE],
    checkpoints: [checkpoint("turn-1", 1)],
  },
  page: { beforeCursor: null, hasMore: false, snapshotSequence: 10 },
};

type LoaderResponse = Option.Option<OrchestrationThreadDetailSnapshot>;

export const makeHarness = Effect.fn("TestThreadPagination.makeHarness")(function* (options?: {
  readonly paginationCapability?: boolean;
  readonly initialResponse?: LoaderResponse;
  /** Cached snapshot returned by the cache store (simulates a warm cache). */
  readonly cached?: OrchestrationThreadDetailSnapshot;
}) {
  const inputs = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const loaderWindows = yield* Ref.make<ReadonlyArray<ThreadSnapshotWindow | undefined>>([]);

  const lastSubscribeInput = yield* Ref.make<
    Parameters<WsRpcProtocolClient[typeof ORCHESTRATION_WS_METHODS.subscribeThread]>[0] | undefined
  >(undefined);

  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationThreadDetailSnapshot>>([]);
  // Older-page responses resolve through deferreds so tests can interleave
  // live events with an in-flight page fetch.
  const pendingPageResponses = yield* Queue.unbounded<Deferred.Deferred<LoaderResponse>>();

  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );

  const client = testRpcClient({
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (
      input: Parameters<WsRpcProtocolClient[typeof ORCHESTRATION_WS_METHODS.subscribeThread]>[0],
    ) =>
      Stream.unwrap(Ref.set(lastSubscribeInput, input).pipe(Effect.as(Stream.fromQueue(inputs)))),
  });

  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({
      ...TEST_SERVER_CONFIG,
      threadSnapshotPagination: options?.paginationCapability !== false,
    }),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };

  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(session),
  );

  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );

  const snapshotLoader = ThreadSnapshotLoader.of({
    load: (_prepared, _threadId, window) =>
      Ref.update(loaderWindows, (current) => [...current, window]).pipe(
        Effect.andThen(
          window?.beforeCursor === undefined
            ? Effect.succeed(
                options?.initialResponse ?? Option.none<OrchestrationThreadDetailSnapshot>(),
              )
            : Deferred.make<LoaderResponse>().pipe(
                Effect.tap((deferred) => Queue.offer(pendingPageResponses, deferred)),
                Effect.flatMap(Deferred.await),
              ),
        ),
      ),
  });

  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
    retryIfDesired: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () =>
      Effect.succeed(options?.cached !== undefined ? Option.some(options.cached) : Option.none()),
    saveThread: (_environmentId, thread) =>
      Ref.update(savedThreads, (current) => [...current, thread]),
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    clear: () => Effect.void,
  });

  const threadState = yield* environmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
  );

  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) => Queue.offer(observed, state)),
    Effect.forkScoped,
  );

  const awaitState = (predicate: (state: EnvironmentThreadState) => boolean) =>
    Queue.take(observed).pipe(Effect.repeat({ until: predicate }));

  const resolveNextPage = (response: LoaderResponse) =>
    Queue.take(pendingPageResponses).pipe(
      Effect.flatMap((deferred) => Deferred.succeed(deferred, response)),
    );

  return {
    inputs,
    observed,
    awaitState,
    resolveNextPage,
    loaderWindows,
    lastSubscribeInput,
    savedThreads,
    threadState,
  };
});

export const hasMessage = (state: EnvironmentThreadState, id: string): boolean =>
  Option.match(state.data, {
    onNone: () => false,
    onSome: (thread) => thread.messages.some((entry) => entry.id === id),
  });

export const titleEvent = (title: string, sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-title-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T01:30:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.meta-updated",
    payload: {
      threadId: THREAD_ID,
      title,
      updatedAt: "2026-04-01T01:30:00.000Z",
    },
  },
});

// Reverting to turnCount 1 retains only turns whose checkpoint count is <= 1:
// turn-1 survives, turn-2 (the loaded window's newest turn) is discarded.
export const revertEvent = (sequence: number): OrchestrationThreadStreamItem => ({
  kind: "event",
  event: {
    eventId: EventId.make(`event-revert-${sequence}`),
    sequence,
    occurredAt: "2026-04-01T02:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.reverted",
    payload: {
      threadId: THREAD_ID,
      turnCount: 1,
    },
  },
});
