import { makeLocalFileTracer, makeTraceSink } from "@akeru/shared/observability";
import { parsePersistedServerObservabilitySettings } from "@akeru/shared/serverSettings";
import * as Context from "effect/Context";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as Tracer from "effect/Tracer";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { DESKTOP_LOG_FILE_MAX_BYTES, DESKTOP_LOG_FILE_MAX_FILES } from "./RotatingLogWriter.ts";

export const DESKTOP_TRACE_BATCH_WINDOW_MS = 1_000;

export class DesktopTraceShutdown extends Context.Service<
  DesktopTraceShutdown,
  { readonly close: Effect.Effect<void> }
>()("@akeru/desktop/app/DesktopOtlp/DesktopTraceShutdown") {}

export const readPersistedOtlpTracesUrl: Effect.Effect<
  Option.Option<string>,
  never,
  FileSystem.FileSystem | DesktopEnvironment.DesktopEnvironment
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fileSystem.readFileString(environment.serverSettingsPath).pipe(Effect.option);

  if (Option.isNone(raw)) {
    return Option.none();
  }

  const parsed = parsePersistedServerObservabilitySettings(raw.value);

  return Option.fromNullishOr(parsed.otlpTracesUrl);
});

export const resolveOtlpTracesUrl = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;

  if (Option.isSome(environment.otlpTracesUrl)) {
    return environment.otlpTracesUrl;
  }

  return yield* readPersistedOtlpTracesUrl;
});

export const tracerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const otlpTracesUrl = yield* resolveOtlpTracesUrl;
    const tracePath = environment.path.join(environment.logDir, "desktop.trace.ndjson");

    const sink = yield* makeTraceSink({
      filePath: tracePath,
      maxBytes: DESKTOP_LOG_FILE_MAX_BYTES,
      maxFiles: DESKTOP_LOG_FILE_MAX_FILES,
      batchWindowMs: DESKTOP_TRACE_BATCH_WINDOW_MS,
    });

    const delegate = Option.isNone(otlpTracesUrl)
      ? undefined
      : yield* OtlpTracer.make({
          url: otlpTracesUrl.value,
          exportInterval: `${environment.otlpExportIntervalMs} millis`,
          resource: {
            serviceName: "desktop",
            attributes: {
              "service.runtime": "desktop",
              "service.mode": environment.isDevelopment ? "development" : "packaged",
            },
          },
        });

    const tracer = yield* makeLocalFileTracer({
      filePath: tracePath,
      maxBytes: DESKTOP_LOG_FILE_MAX_BYTES,
      maxFiles: DESKTOP_LOG_FILE_MAX_FILES,
      batchWindowMs: DESKTOP_TRACE_BATCH_WINDOW_MS,
      sink,
      ...(delegate ? { delegate } : {}),
    });

    return Layer.mergeAll(
      Layer.succeed(Tracer.Tracer, tracer),
      Layer.succeed(DesktopTraceShutdown, { close: sink.close() }),
    );
  }),
).pipe(Layer.provide(OtlpExporter.layerFlusher), Layer.provideMerge(OtlpSerialization.layerJson));
