import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@akeru/contracts";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { type RotatingLogFileWriter, createRotatingLogFileWriter } from "./RotatingLogWriter.ts";

export const DESKTOP_BACKEND_CHILD_LOG_FIBER_ID = "#backend-child";

export const DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_BYTES = 1024 * 1024;

export const DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_CHUNKS = 256;

export interface DesktopBackendOutputLogShape {
  readonly beginSession: (input: { readonly details: string }) => Effect.Effect<void>;
  readonly writeOutputChunk: (
    streamName: "stdout" | "stderr",
    chunk: Uint8Array,
  ) => Effect.Effect<void>;
  readonly persistFailureSnapshot: (input: { readonly details: string }) => Effect.Effect<void>;
  readonly persistFailure: (input: { readonly details: string }) => Effect.Effect<void>;
  readonly discardSession: Effect.Effect<void>;
}

// Factory for per-instance backend output logs. `forInstance(id)` returns
// a writer that targets a distinct rotating log file — the primary
// instance keeps `server-child.log` so the historical path stays stable
// for ops; other instances get `server-child-<sanitized-id>.log`.
//
// Writers are cached per id within a single factory instance so repeated
// `forInstance` calls (e.g. during a backend restart that re-resolves
// services) reuse the same rotating writer rather than racing each other
// on the same file.
export class DesktopBackendOutputLogFactory extends Context.Service<
  DesktopBackendOutputLogFactory,
  {
    readonly forInstance: (id: string) => Effect.Effect<DesktopBackendOutputLogShape>;
  }
>()("@akeru/desktop/app/BackendOutputLogging/DesktopBackendOutputLogFactory") {}

export const textDecoder = new TextDecoder();

export const sanitizeLogValue = (value: string): string => value.replace(/\s+/g, " ").trim();

export const DesktopBackendChildLogRecord = Schema.Struct({
  message: Schema.String,
  level: Schema.Literals(["INFO", "ERROR"]),
  timestamp: Schema.String,
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  spans: Schema.Record(Schema.String, Schema.Unknown),
  fiberId: Schema.String,
});

export const encodeDesktopBackendChildLogRecord = Schema.encodeEffect(
  Schema.fromJsonString(DesktopBackendChildLogRecord),
);

export const DesktopBackendOutputLogNoop: DesktopBackendOutputLogShape = {
  beginSession: () => Effect.void,
  writeOutputChunk: () => Effect.void,
  persistFailureSnapshot: () => Effect.void,
  persistFailure: () => Effect.void,
  discardSession: Effect.void,
};

export interface BufferedBackendOutputChunk {
  readonly streamName: "stdout" | "stderr";
  readonly chunk: Uint8Array;
  readonly offset: number;
}

export interface BackendOutputSession {
  readonly runId: string;
  readonly startDetails: string;
  readonly chunks: ReadonlyArray<BufferedBackendOutputChunk>;
  readonly byteLength: number;
}

export function appendBoundedOutputChunk(
  session: BackendOutputSession,
  streamName: "stdout" | "stderr",
  chunk: Uint8Array,
): BackendOutputSession {
  if (chunk.byteLength === 0) {
    return session;
  }

  const retainedChunk =
    chunk.byteLength > DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_BYTES
      ? chunk.slice(chunk.byteLength - DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_BYTES)
      : chunk.slice();

  const chunks = [...session.chunks, { streamName, chunk: retainedChunk, offset: 0 }];
  let byteLength = session.byteLength + retainedChunk.byteLength;
  let overflow = Math.max(0, byteLength - DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_BYTES);
  let firstRetainedIndex = 0;

  while (overflow > 0) {
    const first = chunks[firstRetainedIndex];

    if (!first) break;
    const retainedByteLength = first.chunk.byteLength - first.offset;

    if (retainedByteLength <= overflow) {
      overflow -= retainedByteLength;
      byteLength -= retainedByteLength;
      firstRetainedIndex += 1;
      continue;
    }

    chunks[firstRetainedIndex] = {
      ...first,
      offset: first.offset + overflow,
    };
    byteLength -= overflow;
    overflow = 0;
  }

  const excessChunks = Math.max(
    0,
    chunks.length - firstRetainedIndex - DESKTOP_BACKEND_OUTPUT_BUFFER_MAX_CHUNKS,
  );

  for (let index = firstRetainedIndex; index < firstRetainedIndex + excessChunks; index += 1) {
    const chunk = chunks[index];
    byteLength -= chunk ? chunk.chunk.byteLength - chunk.offset : 0;
  }

  firstRetainedIndex += excessChunks;

  return {
    ...session,
    chunks: chunks.slice(firstRetainedIndex),
    byteLength,
  };
}

export const currentDesktopRunId = Effect.gen(function* () {
  const annotations = yield* References.CurrentLogAnnotations;
  const runId = annotations.runId;

  return typeof runId === "string" && runId.length > 0 ? runId : "unknown";
});

export const writeDevelopmentConsoleOutput = (
  streamName: "stdout" | "stderr",
  chunk: Uint8Array,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const output = streamName === "stderr" ? process.stderr : process.stdout;
    output.write(chunk);
  }).pipe(Effect.ignore);

export const writeBackendChildLogRecord = Effect.fn(
  "desktop.observability.writeBackendChildLogRecord",
)(function* (
  logFile: RotatingLogFileWriter,
  input: {
    readonly message: string;
    readonly level: "INFO" | "ERROR";
    readonly annotations: Record<string, unknown>;
  },
): Effect.fn.Return<void> {
  return yield* Effect.gen(function* () {
    const timestamp = DateTime.formatIso(yield* DateTime.now);

    const encoded = yield* encodeDesktopBackendChildLogRecord({
      message: input.message,
      level: input.level,
      timestamp,
      annotations: input.annotations,
      spans: {},
      fiberId: DESKTOP_BACKEND_CHILD_LOG_FIBER_ID,
    });

    yield* logFile.writeText(`${encoded}\n`);
  }).pipe(Effect.ignore({ log: true }));
});

export const PRIMARY_BACKEND_LOG_INSTANCE_ID = PRIMARY_LOCAL_ENVIRONMENT_ID;

export const sanitizeInstanceIdForFileName = (id: string): string =>
  id.replace(/[^a-zA-Z0-9._-]+/g, "_");

export const backendLogFilePathForInstance = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  id: string,
): string => {
  // Primary keeps the historical "server-child.log" path so ops scripts
  // and packaged-build log inspection still find it where it always lived.
  if (id === PRIMARY_BACKEND_LOG_INSTANCE_ID) {
    return environment.path.join(environment.logDir, "server-child.log");
  }

  const sanitized = sanitizeInstanceIdForFileName(id);

  return environment.path.join(environment.logDir, `server-child-${sanitized}.log`);
};

// Just the IO sink. Cacheable by resolved file path so two ids that
// sanitize to the same filename share a single RotatingLogFileWriter
// (no race on currentSize tracking). Splitting the sink off from the
// per-call shape lets the shape annotate writes with the *caller's*
// id rather than whatever id created the cached writer first.
export const makeBackendOutputSinkForInstance = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  id: string,
): Effect.Effect<
  Option.Option<RotatingLogFileWriter>,
  never,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
  createRotatingLogFileWriter({
    filePath: backendLogFilePathForInstance(environment, id),
  }).pipe(Effect.option);

export const makeBackendOutputLogShape = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  id: string,
  sink: Option.Option<RotatingLogFileWriter>,
): Effect.Effect<DesktopBackendOutputLogShape> =>
  Option.match(sink, {
    onNone: () => Effect.succeed(DesktopBackendOutputLogNoop),
    onSome: (logFile) =>
      Effect.gen(function* () {
        const sessionRef = yield* Ref.make(Option.none<BackendOutputSession>());

        const writeFailure = Effect.fn("desktop.observability.backendOutput.writeFailure")(
          function* (session: BackendOutputSession, details: string) {
            yield* writeBackendChildLogRecord(logFile, {
              message: "backend child process failure output start",
              level: "ERROR",
              annotations: {
                component: "desktop-backend-child",
                runId: session.runId,
                instanceId: id,
                phase: "START",
                details: session.startDetails,
              },
            });

            for (const output of session.chunks) {
              yield* writeBackendChildLogRecord(logFile, {
                message: "backend child process output",
                level: output.streamName === "stderr" ? "ERROR" : "INFO",
                annotations: {
                  component: "desktop-backend-child",
                  runId: session.runId,
                  instanceId: id,
                  stream: output.streamName,
                  text: textDecoder.decode(output.chunk.subarray(output.offset)),
                },
              });
            }

            yield* writeBackendChildLogRecord(logFile, {
              message: "backend child process failure output end",
              level: "ERROR",
              annotations: {
                component: "desktop-backend-child",
                runId: session.runId,
                instanceId: id,
                phase: "END",
                details: sanitizeLogValue(details),
              },
            });
          },
        );

        return {
          beginSession: Effect.fn("desktop.observability.backendOutput.beginSession")(function* ({
            details,
          }) {
            const runId = yield* currentDesktopRunId;
            yield* Ref.set(
              sessionRef,
              Option.some({
                runId,
                startDetails: sanitizeLogValue(details),
                chunks: [],
                byteLength: 0,
              }),
            );
          }),
          writeOutputChunk: Effect.fnUntraced(function* (streamName, chunk) {
            if (environment.isDevelopment) {
              yield* writeDevelopmentConsoleOutput(streamName, chunk);
            }

            yield* Ref.update(
              sessionRef,
              Option.map((session) => appendBoundedOutputChunk(session, streamName, chunk)),
            );
          }),
          persistFailureSnapshot: Effect.fn(
            "desktop.observability.backendOutput.persistFailureSnapshot",
          )(function* ({ details }) {
            const session = yield* Ref.get(sessionRef);

            if (Option.isSome(session)) {
              yield* writeFailure(session.value, details);
            }
          }),
          persistFailure: Effect.fn("desktop.observability.backendOutput.persistFailure")(
            function* ({ details }) {
              const session = yield* Ref.modify(sessionRef, (current) => [current, Option.none()]);

              if (Option.isNone(session)) return;
              yield* writeFailure(session.value, details);
            },
          ),
          discardSession: Ref.set(sessionRef, Option.none()),
        } satisfies DesktopBackendOutputLogShape;
      }),
  });

export const backendOutputLogFactoryLayer = Layer.effect(
  DesktopBackendOutputLogFactory,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const factoryScope = yield* Scope.Scope;

    // Per-file-path cache of the IO sink only. The per-call shape
    // wraps the sink with the caller's instance id so a cache hit on
    // a path collision (e.g. "wsl:default" and "wsl_default" both
    // resolve to server-child-wsl_default.log) doesn't attribute the
    // second caller's writes to the first caller's id. Each sink pins
    // itself to the factory's scope so all log resources tear down
    // together at app exit. Mutex serializes concurrent first-time
    // lookups for the same file path.
    const cacheRef = yield* SynchronizedRef.make<
      ReadonlyMap<string, Option.Option<RotatingLogFileWriter>>
    >(new Map());

    const makeForId = (id: string): Effect.Effect<DesktopBackendOutputLogShape> =>
      SynchronizedRef.modifyEffect(cacheRef, (cache) => {
        const cacheKey = backendLogFilePathForInstance(environment, id);
        const cached = cache.get(cacheKey);

        if (cached !== undefined) {
          return makeBackendOutputLogShape(environment, id, cached).pipe(
            Effect.map((outputLog) => [outputLog, cache] as const),
          );
        }

        return makeBackendOutputSinkForInstance(environment, id).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Scope.provide(factoryScope),
          Effect.map((sink) => {
            const next = new Map(cache);
            next.set(cacheKey, sink);

            return { sink, next };
          }),
          Effect.flatMap(({ sink, next }) =>
            makeBackendOutputLogShape(environment, id, sink).pipe(
              Effect.map(
                (outputLog) =>
                  [
                    outputLog,
                    next as ReadonlyMap<string, Option.Option<RotatingLogFileWriter>>,
                  ] as const,
              ),
            ),
          ),
        );
      });

    return DesktopBackendOutputLogFactory.of({
      forInstance: (id) => makeForId(id),
    });
  }),
);
