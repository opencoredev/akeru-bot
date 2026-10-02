import type * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { OtlpResource, OtlpTracer } from "effect/unstable/observability";
import {
  type TraceRecordEvent,
  type TraceRecordLink,
  type OtlpTraceRecord,
  type OtlpSpan,
  type OtlpSpanEvent,
  type OtlpSpanLink,
  type OtlpSpanStatus,
} from "./types.ts";
import { compactTraceAttributes } from "./attributes.ts";

const SPAN_KIND_MAP = new Map<number, string>([
  [1, "internal"],
  [2, "server"],
  [3, "client"],
  [4, "producer"],
  [5, "consumer"],
]);

export function decodeOtlpTraceRecords(
  payload: OtlpTracer.TraceData,
): ReadonlyArray<OtlpTraceRecord> {
  const records: Array<OtlpTraceRecord> = [];

  for (const resourceSpan of payload.resourceSpans) {
    const resourceAttributes = decodeAttributes(resourceSpan.resource?.attributes ?? []);

    for (const scopeSpan of resourceSpan.scopeSpans) {
      for (const span of scopeSpan.spans) {
        records.push(
          otlpSpanToTraceRecord({
            resourceAttributes,
            scopeAttributes: decodeAttributes(
              "attributes" in scopeSpan.scope && Array.isArray(scopeSpan.scope.attributes)
                ? scopeSpan.scope.attributes
                : [],
            ),
            scopeName: scopeSpan.scope.name,
            scopeVersion:
              "version" in scopeSpan.scope && Predicate.isString(scopeSpan.scope.version)
                ? scopeSpan.scope.version
                : undefined,
            span,
          }),
        );
      }
    }
  }

  return records;
}

function otlpSpanToTraceRecord(input: {
  readonly resourceAttributes: Readonly<Record<string, Schema.Json>>;
  readonly scopeAttributes: Readonly<Record<string, Schema.Json>>;
  readonly scopeName: string | undefined;
  readonly scopeVersion: string | undefined;
  readonly span: OtlpSpan;
}): OtlpTraceRecord {
  return {
    type: "otlp-span",
    name: input.span.name,
    traceId: input.span.traceId,
    spanId: input.span.spanId,
    ...(input.span.parentSpanId ? { parentSpanId: input.span.parentSpanId } : {}),
    sampled: true,
    kind: normalizeSpanKind(input.span.kind),
    startTimeUnixNano: input.span.startTimeUnixNano,
    endTimeUnixNano: input.span.endTimeUnixNano,
    durationMs:
      Number(parseBigInt(input.span.endTimeUnixNano) - parseBigInt(input.span.startTimeUnixNano)) /
      1_000_000,
    attributes: decodeAttributes(input.span.attributes),
    resourceAttributes: input.resourceAttributes,
    scope: {
      ...(input.scopeName ? { name: input.scopeName } : {}),
      ...(input.scopeVersion ? { version: input.scopeVersion } : {}),
      attributes: input.scopeAttributes,
    },
    events: decodeEvents(input.span.events),
    links: decodeLinks(input.span.links),
    status: decodeStatus(input.span.status),
  };
}

function decodeStatus(input: OtlpSpanStatus): OtlpTraceRecord["status"] {
  const code = String(input.code);
  const message = input.message;

  return {
    code,
    ...(message ? { message } : {}),
  };
}

function decodeEvents(input: ReadonlyArray<OtlpSpanEvent>): ReadonlyArray<TraceRecordEvent> {
  return input.map((current) => ({
    name: current.name,
    timeUnixNano: current.timeUnixNano,
    attributes: decodeAttributes(current.attributes),
  }));
}

function decodeLinks(input: ReadonlyArray<OtlpSpanLink>): ReadonlyArray<TraceRecordLink> {
  return input.flatMap((current) => {
    const traceId = current.traceId;
    const spanId = current.spanId;

    return {
      traceId,
      spanId,
      attributes: decodeAttributes(current.attributes),
    };
  });
}

function decodeAttributes(
  input: ReadonlyArray<OtlpResource.KeyValue>,
): Readonly<Record<string, Schema.Json>> {
  const entries: Record<string, Schema.Json> = {};

  for (const attribute of input) {
    entries[attribute.key] = decodeValue(attribute.value);
  }

  return compactTraceAttributes(entries);
}

function decodeValue(input: OtlpResource.AnyValue | null | undefined): Schema.Json {
  if (input == null) {
    return null;
  }

  if ("stringValue" in input) {
    return input.stringValue;
  }

  if ("boolValue" in input) {
    return input.boolValue;
  }

  if ("intValue" in input) {
    return input.intValue;
  }

  if ("doubleValue" in input) {
    return input.doubleValue;
  }

  if ("bytesValue" in input) {
    return Object.fromEntries(
      Array.from(input.bytesValue.entries(), ([key, value]): [string, number] => [
        String(key),
        value,
      ]),
    );
  }

  if (input.arrayValue) {
    return input.arrayValue.values.map((entry) => decodeValue(entry));
  }

  if (input.kvlistValue) {
    return decodeAttributes(input.kvlistValue.values);
  }

  return null;
}

function normalizeSpanKind(input: number): OtlpTraceRecord["kind"] {
  return SPAN_KIND_MAP.get(input) || "internal";
}

function parseBigInt(input: string): bigint {
  try {
    return BigInt(input);
  } catch {
    return 0n;
  }
}
