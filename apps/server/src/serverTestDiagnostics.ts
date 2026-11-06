import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import { TEST_EPOCH } from "./serverTestFixtures.ts";

/**
 * Empty process, resource-history, and trace diagnostics that
 * `buildAppUnderTest` provides to every test server, so it starts without
 * sampling the host. They take no per-test overrides.
 */
export const diagnosticsTestLayer = Layer.mergeAll(
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({
    read: Effect.succeed({
      serverPid: process.pid,
      readAt: TEST_EPOCH,
      processCount: 0,
      totalRssBytes: 0,
      totalCpuPercent: 0,
      processes: [],
      error: Option.none(),
    }),
    signal: (input) =>
      Effect.succeed({
        pid: input.pid,
        signal: input.signal,
        signaled: true,
        message: Option.none(),
      }),
  }),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({
    readHistory: (input) =>
      Effect.succeed({
        readAt: TEST_EPOCH,
        windowMs: input.windowMs,
        bucketMs: input.bucketMs,
        sampleIntervalMs: 5_000,
        retainedSampleCount: 0,
        totalCpuSecondsApprox: 0,
        buckets: [],
        topProcesses: [],
        error: Option.none(),
      }),
  }),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({
    read: () =>
      Effect.succeed({
        traceFilePath: "",
        scannedFilePaths: [],
        readAt: TEST_EPOCH,
        recordCount: 0,
        parseErrorCount: 0,
        firstSpanAt: Option.none(),
        lastSpanAt: Option.none(),
        failureCount: 0,
        interruptionCount: 0,
        slowSpanThresholdMs: 1_000,
        slowSpanCount: 0,
        logLevelCounts: {},
        topSpansByCount: [],
        slowestSpans: [],
        commonFailures: [],
        latestFailures: [],
        latestWarningAndErrorLogs: [],
        partialFailure: Option.none(),
        error: Option.none(),
      }),
  }),
);
