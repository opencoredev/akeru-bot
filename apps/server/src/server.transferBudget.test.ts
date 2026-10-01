// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  type OrchestrationThreadStreamItem,
  ORCHESTRATION_WS_METHODS,
  ProviderDriverKind,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { isThreadDetailEvent } from "./ws.ts";
import { makeOrchestrationIntegrationHarness } from "../integration/OrchestrationEngineHarness.integration.ts";
import {
  countingWsRpcProtocolLayer,
  makeCountingWsRpcClient,
  makeWebSocketTransferRecorder,
  measureHttpGet,
  transferDelta,
} from "../integration/NetworkTransferMeasurement.integration.ts";
import {
  expectedMeasuredAssistantText,
  queueMeasuredTransferTurn,
  seedTransferBudgetHistory,
  TRANSFER_HISTORY_TURN_COUNT,
  TRANSFER_MEASURED_TURN_CREATED_AT,
  TRANSFER_MEASURED_TURN_INDEX,
  TRANSFER_THREAD_ID,
  transferModelSelection,
  waitForTurnQuiesced,
} from "../integration/TransferBudgetScenario.integration.ts";
import {
  formatTransferBudgetReport,
  formatTransferBudgetResult,
  type TransferBudgetRun,
  transferBudgetViolations,
} from "../integration/TransferBudgetReport.integration.ts";

import { buildAppUnderTest } from "./serverTestApp.ts";
import { readyWorktreeProvider } from "./serverTestFixtures.ts";
import {
  getHttpServerUrl,
  getAuthenticatedSessionCookieHeader,
  decodeTransferThreadSnapshot,
  collectQueueUntil,
  NodeHttpServerTestWithWsDeflate,
} from "./serverTestClients.ts";

it.live(
  "reports thread HTTP and WebSocket transfer budgets",
  () =>
    Effect.gen(function* () {
      const providers = [ProviderDriverKind.make("opencode")] as const;

      const runs = yield* Effect.forEach(
        providers,
        (provider) =>
          Effect.acquireUseRelease(
            makeOrchestrationIntegrationHarness({ provider }),
            (harness) =>
              Effect.gen(function* () {
                yield* seedTransferBudgetHistory(harness, provider);
                yield* buildAppUnderTest({
                  layers: {
                    providerRegistry: { getProviders: Effect.succeed([readyWorktreeProvider]) },
                    orchestrationEngine: harness.engine,
                    projectionSnapshotQuery: harness.snapshotQuery,
                  },
                });

                const baseUrl = yield* getHttpServerUrl();
                const cookie = yield* getAuthenticatedSessionCookieHeader();

                const recorder = makeWebSocketTransferRecorder();
                const wsUrl = baseUrl.replace(/^http:/, "ws:") + "/ws";

                const protocolLayer = countingWsRpcProtocolLayer({
                  url: wsUrl,
                  cookie,
                  recorder,
                });

                return yield* Effect.scoped(
                  Effect.gen(function* () {
                    const client = yield* makeCountingWsRpcClient;

                    const threadSnapshot = yield* measureHttpGet({
                      url: `${baseUrl}/api/orchestration/threads/${TRANSFER_THREAD_ID}`,
                      headers: { cookie },
                    });

                    assert.equal(threadSnapshot.status, 200);
                    assert.equal(threadSnapshot.contentEncoding, "gzip");

                    const decodedThread = yield* decodeTransferThreadSnapshot(
                      Buffer.from(threadSnapshot.decodedBody).toString("utf8"),
                    );

                    assert.equal(
                      decodedThread.thread.messages.length,
                      TRANSFER_HISTORY_TURN_COUNT * 2,
                    );

                    const threadItems = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
                    yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                      threadId: TRANSFER_THREAD_ID,
                      afterSequence: decodedThread.snapshotSequence,
                      requestCompletionMarker: true,
                    }).pipe(
                      Stream.runForEach((item) =>
                        Queue.offer(threadItems, item).pipe(Effect.asVoid),
                      ),
                      Effect.forkScoped,
                    );

                    const initialThreadItems = yield* collectQueueUntil(
                      threadItems,
                      (item) => item.kind === "synchronized",
                      `${provider} thread subscription to synchronize`,
                    );

                    assert.isFalse(initialThreadItems.some((item) => item.kind === "snapshot"));
                    assert.include(recorder.negotiatedExtensions(), "permessage-deflate");

                    yield* queueMeasuredTransferTurn(harness, provider);
                    const turnStartTotals = recorder.totals();
                    yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                      type: "thread.turn.start",
                      commandId: CommandId.make(`transfer:${provider}:measured-turn`),
                      threadId: TRANSFER_THREAD_ID,
                      message: {
                        messageId: MessageId.make("transfer-user-measured"),
                        role: "user",
                        text: "Measure the client-bound transfer for this turn.",
                        attachments: [],
                      },
                      modelSelection: transferModelSelection(provider),
                      runtimeMode: "approval-required",
                      interactionMode: "default",
                      createdAt: TRANSFER_MEASURED_TURN_CREATED_AT,
                    });
                    yield* waitForTurnQuiesced(harness, TRANSFER_MEASURED_TURN_INDEX + 1);

                    const finalThreadSequence = yield* harness.engine
                      .readEvents(decodedThread.snapshotSequence, 10_000)
                      .pipe(
                        Stream.runFold(
                          () => decodedThread.snapshotSequence,
                          (sequence, event) =>
                            event.aggregateId === TRANSFER_THREAD_ID && isThreadDetailEvent(event)
                              ? Math.max(sequence, event.sequence)
                              : sequence,
                        ),
                      );

                    assert.isAbove(finalThreadSequence, decodedThread.snapshotSequence);

                    yield* collectQueueUntil(
                      threadItems,
                      (item) =>
                        item.kind === "event" && item.event.sequence === finalThreadSequence,
                      `${provider} thread stream to reach sequence ${finalThreadSequence}`,
                    );
                    const measuredTurnWebSocket = transferDelta(turnStartTotals, recorder.totals());

                    const finalThreadSnapshot = yield* harness.snapshotQuery
                      .getThreadDetailSnapshot(TRANSFER_THREAD_ID)
                      .pipe(Effect.map(Option.getOrThrow));

                    const expectedAssistantText = expectedMeasuredAssistantText(provider);

                    const measuredAssistant = finalThreadSnapshot.thread.messages.find(
                      (message) =>
                        message.role === "assistant" && message.text === expectedAssistantText,
                    );

                    assert.isDefined(measuredAssistant);
                    assert.isTrue(
                      finalThreadSnapshot.thread.messages.length >= TRANSFER_HISTORY_TURN_COUNT * 2,
                    );
                    assert.equal(measuredAssistant?.streaming, false);
                    assert.equal(finalThreadSnapshot.thread.session?.status, "ready");
                    assert.equal(
                      finalThreadSnapshot.thread.checkpoints.length,
                      TRANSFER_HISTORY_TURN_COUNT + 1,
                    );

                    return {
                      provider,
                      threadSnapshot,
                      measuredTurnWebSocket,
                    } satisfies TransferBudgetRun;
                  }).pipe(Effect.provide(protocolLayer)),
                );
              }),
            (harness) => harness.dispose,
          ).pipe(Effect.provide(NodeHttpServerTestWithWsDeflate)),
        { concurrency: 1 },
      );

      const report = formatTransferBudgetReport(runs);
      yield* Effect.logInfo(`\n${report}`);

      const reportPath = yield* Config.string("T3CODE_TRANSFER_BUDGET_REPORT_PATH").pipe(
        Config.option,
      );

      if (Option.isSome(reportPath)) {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(reportPath.value, report);
      }

      const resultPath = yield* Config.string("T3CODE_TRANSFER_BUDGET_RESULT_PATH").pipe(
        Config.option,
      );

      if (Option.isSome(resultPath)) {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(resultPath.value, formatTransferBudgetResult(runs));
      }

      assert.deepEqual(transferBudgetViolations(runs), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
