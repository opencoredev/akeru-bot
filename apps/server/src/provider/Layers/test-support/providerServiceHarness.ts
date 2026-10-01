// @effect-diagnostics nodeBuiltinImport:off
import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "@akeru/contracts";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import { it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProviderAdapterSessionNotFoundError, type ProviderAdapterError } from "../../Errors.ts";
import type { ProviderAdapterShape } from "../../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../ProviderService.ts";
import * as ProviderEventLoggers from "../ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "../ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { makeAdapterRegistryMock } from "../../testUtils/providerAdapterRegistryMock.ts";

export const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();

export const serverConfigTestLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provide(NodeServices.layer),
);

export const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);

export const asEventId = (value: string): EventId => EventId.make(value);

export const asThreadId = (value: string): ThreadId => ThreadId.make(value);

export const asTurnId = (value: string): TurnId => TurnId.make(value);

export const codexInstanceId = ProviderInstanceId.make("codex");

export const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");

export const CODEX_DRIVER = ProviderDriverKind.make("codex");

export const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

export const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

export type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

export function makeFakeCodexAdapter(provider: ProviderDriverKind = CODEX_DRIVER) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = "2026-01-01T00:00:00.000Z";

      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? {
          opaque: `resume-${String(input.threadId)}`,
        },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };

      sessions.set(session.threadId, session);

      return session;
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const uploadFeedback = vi.fn(
    (
      input: ProviderUploadFeedbackInput,
    ): Effect.Effect<ProviderUploadFeedbackResult, ProviderAdapterError> =>
      Effect.succeed({ feedbackId: `feedback-${input.threadId}` }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    ...(provider === CODEX_DRIVER ? { uploadFeedback } : {}),
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);

    if (!existing) {
      return;
    }

    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    emit,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    uploadFeedback,
    stopAll,
  };
}

export const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

export const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

export function makeProviderServiceLayer(
  input: {
    readonly directory?: ProviderSessionDirectory.ProviderSessionDirectory["Service"];
  } = {},
) {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);

  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [ProviderDriverKind.make("cursor")]: cursor.adapter,
  });

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );

  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );

  const directoryLayer =
    input.directory === undefined
      ? ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))
      : Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, input.directory);

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    cursor,
    layer,
  };
}

export const activeSessionThreadId = asThreadId("thread-active-session");

export const historicalSessionThreadId = asThreadId("thread-historical-session");

export const revokedThreads: Array<ThreadId> = [];

export const startSessionWith = (
  enableAgentBrowserAccess: boolean,
  threadId: ThreadId,
  imageGeneration: { chatgptEnabled?: boolean; grokEnabled?: boolean } = {},
) =>
  Effect.gen(function* () {
    const issued: Array<ThreadId> = [];
    const capabilities: Array<ReadonlyArray<string>> = [];
    const codex = makeFakeCodexAdapter();

    const providerAdapterLayer = Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistry,
      makeAdapterRegistryMock({ [CODEX_DRIVER]: codex.adapter }),
    );

    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );

    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    const providerLayer = makeProviderServiceLive({
      issueMcpCredential: (request) =>
        Effect.sync(() => {
          issued.push(request.threadId);
          capabilities.push([...(request.capabilities ?? [])].toSorted());

          return undefined;
        }),
      revokeMcpCredential: (revoked) => Effect.sync(() => void revokedThreads.push(revoked)),
    }).pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(
        ServerSettings.ServerSettingsService.layerTest({
          enableAgentBrowserAccess,
          imageGeneration,
        }),
      ),
      Layer.provide(serverConfigTestLayer),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;

      return yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
    }).pipe(Effect.provide(providerLayer));

    return Object.assign(issued, { capabilities });
  });

export function makeProviderServiceHarness() {
  const routing = makeProviderServiceLayer();

  const fanout = makeProviderServiceLayer();

  const validation = makeProviderServiceLayer();

  const listThreadIds = vi.fn(() =>
    Effect.succeed([activeSessionThreadId, historicalSessionThreadId]),
  );

  const getBinding = vi.fn((threadId: ThreadId) =>
    Effect.succeed(
      Option.some({
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
      }),
    ),
  );

  const boundedListing = makeProviderServiceLayer({
    directory: {
      upsert: () => Effect.void,
      getProvider: () => Effect.die("ProviderService.listSessions does not use getProvider"),
      getBinding,
      listThreadIds,
      listBindings: () => Effect.die("ProviderService.listSessions does not use listBindings"),
    },
  });

  return { routing, fanout, validation, listThreadIds, getBinding, boundedListing };
}
