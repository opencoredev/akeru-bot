import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import * as References from "effect/References";

import * as Tracer from "effect/Tracer";

import { backendOutputLogFactoryLayer } from "./BackendOutputLogging.ts";
import { tracerLayer } from "./DesktopOtlp.ts";

export type { RotatingLogFileWriter } from "./RotatingLogWriter.ts";

export type { DesktopBackendOutputLogShape } from "./BackendOutputLogging.ts";

export { DesktopBackendOutputLogFactory } from "./BackendOutputLogging.ts";

export { appendBoundedOutputChunk } from "./BackendOutputLogging.ts";

export { DesktopTraceShutdown } from "./DesktopOtlp.ts";

export type DesktopLogAnnotations = Record<string, unknown>;

export interface DesktopComponentLogger {
  readonly annotate: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    annotations?: DesktopLogAnnotations,
  ) => Effect.Effect<A, E, R>;
  readonly logDebug: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
  readonly logInfo: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
  readonly logWarning: (
    message: string,
    annotations?: DesktopLogAnnotations,
  ) => Effect.Effect<void>;
  readonly logError: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
}

export function makeComponentLogger(component: string): DesktopComponentLogger {
  const annotate: DesktopComponentLogger["annotate"] = (effect, annotations) =>
    effect.pipe(
      Effect.annotateLogs({
        component,
        ...annotations,
      }),
    );

  return {
    annotate,
    logDebug: (message, annotations) => annotate(Effect.logDebug(message), annotations),
    logInfo: (message, annotations) => annotate(Effect.logInfo(message), annotations),
    logWarning: (message, annotations) => annotate(Effect.logWarning(message), annotations),
    logError: (message, annotations) => annotate(Effect.logError(message), annotations),
  };
}

const desktopLoggerLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty(), Logger.tracerLogger], { mergeWithExisting: false }),
  Layer.succeed(References.MinimumLogLevel, "Info"),
);

export const layer = Layer.mergeAll(
  backendOutputLogFactoryLayer,
  desktopLoggerLayer,
  tracerLayer,
  Layer.succeed(Tracer.MinimumTraceLevel, "Info"),
  Layer.succeed(References.TracerTimingEnabled, true),
);
