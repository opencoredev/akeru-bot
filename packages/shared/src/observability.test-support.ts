import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { makeLocalFileTracer, type TraceRecord } from "./observability.ts";

const TraceRecordLine = Schema.Struct({
  name: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  events: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      attributes: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  exit: Schema.optional(
    Schema.Struct({
      _tag: Schema.String,
    }),
  ),
});

const decodeTraceRecordLine = Schema.decodeUnknownSync(Schema.fromJsonString(TraceRecordLine));

export const makeRecord = (name: string, suffix = ""): TraceRecord => ({
  type: "effect-span",
  name,
  traceId: `trace-${name}-${suffix}`,
  spanId: `span-${name}-${suffix}`,
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  durationMs: 1,
  attributes: {
    payload: suffix,
  },
  events: [],
  links: [],
  exit: {
    _tag: "Success",
  },
});

export const readTraceRecords = Effect.fn("readTraceRecords")(function* (tracePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return (yield* fileSystem.readFileString(tracePath))
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeTraceRecordLine(line));
});

export const makeTestLayer = (tracePath: string) =>
  Layer.mergeAll(
    Layer.effect(
      Tracer.Tracer,
      makeLocalFileTracer({
        filePath: tracePath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        batchWindowMs: 10_000,
      }),
    ),
    Logger.layer([Logger.tracerLogger], { mergeWithExisting: false }),
    Layer.succeed(References.MinimumLogLevel, "Info"),
  );

export const nodeServicesIt = it.layer(NodeServices.layer);
