import { createIntegrationLayers } from "./test-support/IntegrationLayers.ts";
import { initializeGitWorkspace } from "./test-support/IntegrationGit.ts";
export { gitRefExists, gitShowFileAtRef } from "./test-support/IntegrationGit.ts";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProviderApprovalDecision,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";

import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../src/checkpointing/CheckpointStore.ts";

import { ProjectionCheckpointRepository } from "../src/persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepository } from "../src/persistence/Services/ProjectionPendingApprovals.ts";
import { usesMastraCode } from "../src/provider/Layers/AgentController.ts";
import { AgentController } from "../src/provider/Services/AgentController.ts";
import { makeTestMastraHarness, type TestMastraHarness } from "./TestMastraHarness.integration.ts";
import { ProviderCommandReactor } from "../src/orchestration/Services/ProviderCommandReactor.ts";
import { CheckpointReactor } from "../src/orchestration/Services/CheckpointReactor.ts";
import { ProviderRuntimeIngestionService } from "../src/orchestration/Services/ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../src/orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../src/orchestration/Services/OrchestrationReactor.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
} from "./TestProviderAdapter.integration.ts";
import { ProviderAdapterSessionNotFoundError } from "../src/provider/Errors.ts";
import { deriveServerPaths } from "../src/config.ts";
import { createObservationHistory } from "./test-support/IntegrationObservations.ts";

class OrchestrationHarnessRuntimeError extends Schema.TaggedErrorClass<OrchestrationHarnessRuntimeError>()(
  "OrchestrationHarnessRuntimeError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const tryRuntimePromise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrchestrationHarnessRuntimeError({ operation, cause }),
  });

export interface OrchestrationIntegrationHarness {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly adapterHarness: TestProviderAdapterHarness | null;
  /** Mastra session stub for Mastra-backed providers, null otherwise. */
  readonly mastraHarness: TestMastraHarness | null;
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly checkpointStore: CheckpointStore.CheckpointStore["Service"];
  readonly checkpointRepository: ProjectionCheckpointRepository["Service"];
  readonly pendingApprovalRepository: ProjectionPendingApprovalRepository["Service"];
  readonly waitForThread: (
    threadId: string,
    predicate: (thread: OrchestrationThread) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<OrchestrationThread, never>;
  readonly waitForDomainEvent: (
    predicate: (event: OrchestrationEvent) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, never>;
  readonly waitForPendingApproval: (
    requestId: string,
    predicate: (row: {
      readonly status: "pending" | "resolved";
      readonly decision: ProviderApprovalDecision | null;
      readonly resolvedAt: string | null;
    }) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    {
      readonly status: "pending" | "resolved";
      readonly decision: ProviderApprovalDecision | null;
      readonly resolvedAt: string | null;
    },
    never
  >;
  readonly waitForReceipt: {
    (
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    <Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
  };
  readonly drainProviderCommands: Effect.Effect<void>;
  readonly drainProviderRuntime: Effect.Effect<void>;
  readonly drainCheckpointReactor: Effect.Effect<void>;
  readonly dispose: Effect.Effect<void, never>;
}

interface MakeOrchestrationIntegrationHarnessOptions {
  readonly provider?: ProviderDriverKind;
  readonly realCodex?: boolean;
}

export const makeOrchestrationIntegrationHarness = (
  options?: MakeOrchestrationIntegrationHarnessOptions,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    const provider = options?.provider ?? ProviderDriverKind.make("codex");
    const useRealCodex = options?.realCodex === true;
    const adapterHarness = useRealCodex
      ? null
      : yield* makeTestProviderAdapterHarness({
          provider,
        });
    // Mastra-backed drivers run through AgentController's session seam rather
    // than the adapter's `sendTurn`, so fake the Mastra harness too; otherwise
    // the controller boots the real Mastra stack and makes live model calls.
    const mastraHarness =
      useRealCodex || !usesMastraCode(provider) ? null : makeTestMastraHarness();
    const rootDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-orchestration-integration-",
    });
    const workspaceDir = path.join(rootDir, "workspace");
    const { stateDir, dbPath } = yield* deriveServerPaths(rootDir, undefined).pipe(
      Effect.provideService(Path.Path, path),
    );
    yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    yield* initializeGitWorkspace(workspaceDir);
    const layer = createIntegrationLayers({
      adapterHarness,
      mastraHarness,
      useRealCodex,
      dbPath,
      rootDir,
      workspaceDir,
    });

    const runtime = ManagedRuntime.make(layer);
    const engine = yield* tryRuntimePromise("load OrchestrationEngine service", () =>
      runtime.runPromise(Effect.service(OrchestrationEngineService)),
    ).pipe(Effect.orDie);
    const reactor = yield* tryRuntimePromise("load OrchestrationReactor service", () =>
      runtime.runPromise(Effect.service(OrchestrationReactor)),
    ).pipe(Effect.orDie);
    const providerRuntimeIngestion = yield* tryRuntimePromise(
      "load ProviderRuntimeIngestion service",
      () => runtime.runPromise(Effect.service(ProviderRuntimeIngestionService)),
    ).pipe(Effect.orDie);
    const providerCommands = yield* tryRuntimePromise("load ProviderCommandReactor service", () =>
      runtime.runPromise(Effect.service(ProviderCommandReactor)),
    ).pipe(Effect.orDie);
    const checkpointReactor = yield* tryRuntimePromise("load CheckpointReactor service", () =>
      runtime.runPromise(Effect.service(CheckpointReactor)),
    ).pipe(Effect.orDie);
    const snapshotQuery = yield* tryRuntimePromise("load ProjectionSnapshotQuery service", () =>
      runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    ).pipe(Effect.orDie);
    const checkpointStore = yield* tryRuntimePromise("load CheckpointStore service", () =>
      runtime.runPromise(Effect.service(CheckpointStore.CheckpointStore)),
    ).pipe(Effect.orDie);
    const checkpointRepository = yield* tryRuntimePromise(
      "load ProjectionCheckpointRepository service",
      () => runtime.runPromise(Effect.service(ProjectionCheckpointRepository)),
    ).pipe(Effect.orDie);
    const pendingApprovalRepository = yield* tryRuntimePromise(
      "load ProjectionPendingApprovalRepository service",
      () => runtime.runPromise(Effect.service(ProjectionPendingApprovalRepository)),
    ).pipe(Effect.orDie);
    const runtimeReceiptBus = yield* tryRuntimePromise("load RuntimeReceiptBus service", () =>
      runtime.runPromise(Effect.service(RuntimeReceiptBus)),
    ).pipe(Effect.orDie);

    const scope = yield* Scope.make("sequential");
    const receipts = createObservationHistory<OrchestrationRuntimeReceipt>();
    const events = createObservationHistory<OrchestrationEvent>();
    const receiptStream = yield* runtimeReceiptBus.subscribeEventsForTest!.pipe(
      Scope.provide(scope),
    );
    const eventStream = yield* engine.subscribeDomainEvents.pipe(Scope.provide(scope));
    yield* Stream.runForEach(receiptStream, receipts.publish).pipe(Effect.forkIn(scope));
    yield* Stream.runForEach(eventStream, events.publish).pipe(Effect.forkIn(scope));
    yield* tryRuntimePromise("start OrchestrationReactor", () =>
      runtime.runPromise(reactor.start().pipe(Scope.provide(scope))),
    ).pipe(Effect.orDie);

    const waitForThread: OrchestrationIntegrationHarness["waitForThread"] = (
      threadId,
      predicate,
      timeoutMs,
    ) =>
      events.readUntil(
        snapshotQuery
          .getSnapshot()
          .pipe(
            Effect.map(
              (snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null,
            ),
          ),
        (thread): thread is OrchestrationThread => thread !== null && predicate(thread),
        `projected thread '${threadId}'`,
        timeoutMs,
      ) as Effect.Effect<OrchestrationThread, never>;

    const waitForDomainEvent: OrchestrationIntegrationHarness["waitForDomainEvent"] = (
      predicate,
      timeoutMs,
    ) =>
      events
        .waitFor(predicate, "domain event", timeoutMs)
        .pipe(Effect.map(() => events.snapshot()));

    const waitForPendingApproval: OrchestrationIntegrationHarness["waitForPendingApproval"] = (
      requestId,
      predicate,
      timeoutMs,
    ) =>
      events.readUntil(
        pendingApprovalRepository
          .getByRequestId({ requestId: ApprovalRequestId.make(requestId) })
          .pipe(
            Effect.map((row) =>
              Option.match(row, {
                onNone: () => null,
                onSome: (value) => ({
                  status: value.status,
                  decision: value.decision,
                  resolvedAt: value.resolvedAt,
                }),
              }),
            ),
          ),
        (
          row,
        ): row is {
          readonly status: "pending" | "resolved";
          readonly decision: ProviderApprovalDecision | null;
          readonly resolvedAt: string | null;
        } => row !== null && predicate(row),
        `pending approval '${requestId}'`,
        timeoutMs,
      ) as Effect.Effect<
        {
          readonly status: "pending" | "resolved";
          readonly decision: ProviderApprovalDecision | null;
          readonly resolvedAt: string | null;
        },
        never
      >;

    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    function waitForReceipt<Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ) {
      return receipts.waitFor(predicate, "runtime receipt", timeoutMs);
    }

    const agentController = yield* tryRuntimePromise("load AgentController service", () =>
      runtime.runPromise(Effect.service(AgentController)),
    ).pipe(Effect.orDie);
    // Turn fixtures and spies keep the adapter harness surface, but a
    // Mastra-backed provider's sessions live in the Mastra stub, so read and
    // queue through it. `stopAll` stops every controller session, the Mastra
    // equivalent of the provider process going away.
    const providerHarness: TestProviderAdapterHarness | null =
      adapterHarness && mastraHarness
        ? {
            ...adapterHarness,
            adapter: {
              ...adapterHarness.adapter,
              stopAll: () =>
                Effect.forEach(
                  mastraHarness.listActiveSessionIds(),
                  (threadId) => agentController.stopSession({ threadId }),
                  { discard: true },
                ).pipe(Effect.orDie),
            },
            queueTurnResponse: (threadId, response) =>
              mastraHarness.hasSession(threadId)
                ? Effect.sync(() => mastraHarness.queueTurnResponse(threadId, response))
                : Effect.fail(
                    new ProviderAdapterSessionNotFoundError({
                      provider,
                      threadId: String(threadId),
                    }),
                  ),
            queueTurnResponseForNextSession: (response) =>
              Effect.sync(() => mastraHarness.queueTurnResponseForNextSession(response)),
            getStartCount: mastraHarness.getStartCount,
            getInterruptCalls: mastraHarness.getInterruptCalls,
            listActiveSessionIds: mastraHarness.listActiveSessionIds,
            getApprovalResponses: mastraHarness.getApprovalResponses,
          }
        : adapterHarness;

    let disposed = false;
    const dispose = Effect.gen(function* () {
      if (disposed) {
        return;
      }
      disposed = true;

      const shutdown = Effect.gen(function* () {
        const closeScopeExit = yield* Effect.exit(Scope.close(scope, Exit.void));
        const disposeRuntimeExit = yield* Effect.exit(Effect.promise(() => runtime.dispose()));

        const failureCause = Exit.isFailure(closeScopeExit)
          ? closeScopeExit.cause
          : Exit.isFailure(disposeRuntimeExit)
            ? disposeRuntimeExit.cause
            : null;

        if (failureCause) {
          return yield* Effect.failCause(failureCause);
        }
      });

      yield* shutdown;
    });

    return {
      rootDir,
      workspaceDir,
      dbPath,
      adapterHarness: providerHarness,
      mastraHarness,
      engine,
      snapshotQuery,
      checkpointStore,
      checkpointRepository,
      pendingApprovalRepository,
      waitForThread,
      waitForDomainEvent,
      waitForPendingApproval,
      waitForReceipt,
      drainProviderCommands: providerCommands.drain,
      drainProviderRuntime: providerRuntimeIngestion.drain,
      drainCheckpointReactor: checkpointReactor.drain,
      dispose,
    } satisfies OrchestrationIntegrationHarness;
  });
