import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { makeTraceSink } from "./observability/traceSink.ts";
import {
  type EffectTraceRecord,
  type LocalFileTracerOptions,
  type SerializableSpan,
} from "./observability/types.ts";
import {
  compactTraceAttributes,
  formatTraceExit,
  truncateTraceAttributes,
} from "./observability/attributes.ts";

export function spanToTraceRecord(span: SerializableSpan): EffectTraceRecord {
  const status = span.status as Extract<Tracer.SpanStatus, { _tag: "Ended" }>;
  const parentSpanId = Option.getOrUndefined(span.parent)?.spanId;

  return {
    type: "effect-span",
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    sampled: span.sampled,
    kind: span.kind,
    startTimeUnixNano: String(status.startTime),
    endTimeUnixNano: String(status.endTime),
    durationMs: Number(status.endTime - status.startTime) / 1_000_000,
    attributes: truncateTraceAttributes(
      compactTraceAttributes(Object.fromEntries(span.attributes)),
    ),
    events: span.events.map(([name, startTime, attributes]) => ({
      name,
      timeUnixNano: String(startTime),
      attributes: truncateTraceAttributes(compactTraceAttributes(attributes)),
    })),
    links: span.links.map((link) => ({
      traceId: link.span.traceId,
      spanId: link.span.spanId,
      attributes: truncateTraceAttributes(compactTraceAttributes(link.attributes)),
    })),
    exit: formatTraceExit(status.exit),
  };
}

class LocalFileSpan implements Tracer.Span {
  readonly _tag = "Span";
  readonly name: string;
  readonly spanId: string;
  readonly traceId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly annotations: Tracer.Span["annotations"];
  readonly links: Array<Tracer.SpanLink>;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;

  status: Tracer.SpanStatus;
  attributes: Map<string, unknown>;
  events: Array<[name: string, startTime: bigint, attributes: Record<string, unknown>]>;
  private readonly delegate: Tracer.Span;
  private readonly push: (record: EffectTraceRecord) => void;

  constructor(
    options: Parameters<Tracer.Tracer["span"]>[0],
    delegate: Tracer.Span,
    push: (record: EffectTraceRecord) => void,
  ) {
    this.delegate = delegate;
    this.push = push;
    this.name = delegate.name;
    this.spanId = delegate.spanId;
    this.traceId = delegate.traceId;
    this.parent = options.parent;
    this.annotations = options.annotations;
    this.links = [...options.links];
    this.sampled = delegate.sampled;
    this.kind = delegate.kind;
    this.status = {
      _tag: "Started",
      startTime: options.startTime,
    };
    this.attributes = new Map();
    this.events = [];
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = {
      _tag: "Ended",
      startTime: this.status.startTime,
      endTime,
      exit,
    };
    this.delegate.end(endTime, exit);

    if (this.sampled) {
      this.push(spanToTraceRecord(this));
    }
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value);
    this.delegate.attribute(key, value);
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    const nextAttributes = attributes ?? {};
    this.events.push([name, startTime, nextAttributes]);
    this.delegate.event(name, startTime, nextAttributes);
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links);
    this.delegate.addLinks(links);
  }
}

export const makeLocalFileTracer = Effect.fn("makeLocalFileTracer")(function* (
  options: LocalFileTracerOptions,
) {
  const sink =
    options.sink ??
    (yield* makeTraceSink({
      filePath: options.filePath,
      maxBytes: options.maxBytes,
      maxFiles: options.maxFiles,
      batchWindowMs: options.batchWindowMs,
      ...(options.maxBufferedBytes !== undefined
        ? { maxBufferedBytes: options.maxBufferedBytes }
        : {}),
      ...(options.onFlush ? { onFlush: options.onFlush } : {}),
    }));

  const delegate =
    options.delegate ??
    Tracer.make({
      span: (spanOptions) => new Tracer.NativeSpan(spanOptions),
    });

  return Tracer.make({
    span(spanOptions) {
      return new LocalFileSpan(spanOptions, delegate.span(spanOptions), sink.push);
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
});
export {
  type TraceSinkOptions,
  type TraceSinkFlushStats,
  type TraceSink,
  makeTraceSink,
} from "./observability/traceSink.ts";
export {
  type TraceAttributes,
  type TraceRecordEvent,
  type TraceRecordLink,
  type EffectTraceRecord,
  type OtlpTraceRecord,
  type TraceRecord,
  type LocalFileTracerOptions,
} from "./observability/types.ts";
export {
  errorTag,
  causeErrorTag,
  compactTraceAttributes,
  truncateTraceAttributes,
} from "./observability/attributes.ts";
export { decodeOtlpTraceRecords } from "./observability/otlp.ts";
