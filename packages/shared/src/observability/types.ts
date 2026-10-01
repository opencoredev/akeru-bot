import type * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { OtlpTracer } from "effect/unstable/observability";
import { type TraceSinkOptions, type TraceSink } from "./traceSink.ts";

export type TraceAttributes = Readonly<Record<string, Schema.Json>>;

export interface TraceRecordEvent {
  readonly name: string;
  readonly timeUnixNano: string;
  readonly attributes: TraceAttributes;
}

export interface TraceRecordLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes: TraceAttributes;
}

interface BaseTraceRecord {
  readonly name: string;
  readonly kind: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly sampled: boolean;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly durationMs: number;
  readonly attributes: TraceAttributes;
  readonly events: ReadonlyArray<TraceRecordEvent>;
  readonly links: ReadonlyArray<TraceRecordLink>;
}

export interface EffectTraceRecord extends BaseTraceRecord {
  readonly type: "effect-span";
  readonly exit:
    | {
        readonly _tag: "Success";
      }
    | {
        readonly _tag: "Interrupted";
        readonly cause: string;
      }
    | {
        readonly _tag: "Failure";
        readonly cause: string;
      };
}

export interface OtlpTraceRecord extends BaseTraceRecord {
  readonly type: "otlp-span";
  readonly resourceAttributes: TraceAttributes;
  readonly scope: Readonly<{
    readonly name?: string;
    readonly version?: string;
    readonly attributes: TraceAttributes;
  }>;
  readonly status?:
    | {
        readonly code?: string;
        readonly message?: string;
      }
    | undefined;
}

export type TraceRecord = EffectTraceRecord | OtlpTraceRecord;

export interface LocalFileTracerOptions extends TraceSinkOptions {
  readonly delegate?: Tracer.Tracer;
  readonly sink?: TraceSink;
}

export type OtlpSpan = OtlpTracer.ScopeSpan["spans"][number];

export type OtlpSpanEvent = OtlpSpan["events"][number];

export type OtlpSpanLink = OtlpSpan["links"][number];

export type OtlpSpanStatus = OtlpSpan["status"];

export interface SerializableSpan {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly status: Tracer.SpanStatus;
  readonly sampled: boolean;
  readonly kind: Tracer.SpanKind;
  readonly attributes: ReadonlyMap<string, unknown>;
  readonly links: ReadonlyArray<Tracer.SpanLink>;
  readonly events: ReadonlyArray<
    readonly [
      name: string,
      startTime: bigint,
      attributes: NonNullable<Parameters<Tracer.Span["event"]>[2]>,
    ]
  >;
}
