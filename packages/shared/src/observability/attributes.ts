import type * as Schema from "effect/Schema";
import type * as Tracer from "effect/Tracer";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";
import * as Cause from "effect/Cause";
import type * as Exit from "effect/Exit";
import * as ExitRuntime from "effect/Exit";
import * as Option from "effect/Option";
import { type TraceAttributes, type EffectTraceRecord } from "./types.ts";

const TraceExit = Data.taggedEnum<EffectTraceRecord["exit"]>();

function isStructuralTag(value: unknown): value is string {
  return (
    Predicate.isString(value) &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z][A-Za-z0-9._:/-]*$/.test(value)
  );
}

export function errorTag(cause: unknown): string {
  try {
    if (Predicate.isObjectOrArray(cause) && "_tag" in cause) {
      return isStructuralTag(cause._tag) ? cause._tag : "TaggedError";
    }

    if (cause instanceof Error) {
      return isStructuralTag(cause.name) ? cause.name : "Error";
    }
  } catch {
    return "UnknownError";
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Diagnostic labels preserve JavaScript primitive categories, including symbol and function.
  return typeof cause;
}

export function causeErrorTag(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findErrorOption(cause);

  if (Option.isSome(failure)) {
    return errorTag(failure.value);
  }

  return cause.reasons[0]?._tag ?? "Empty";
}

const isPlainObject = Predicate.isObject;

function markSeen<T extends object>(value: T, seen: WeakSet<object>): boolean {
  if (seen.has(value)) {
    return true;
  }

  seen.add(value);

  return false;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Trace serialization accepts arbitrary runtime values and normalizes them to JSON.
function normalizeJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): Schema.Json {
  if (
    value === null ||
    value === undefined ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value ?? null;
  }

  if (Predicate.isBigInt(value)) {
    return value.toString();
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }

  if (Array.isArray(value)) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }

    return value.map((entry) => normalizeJsonValue(entry, seen));
  }

  if (value instanceof Map) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }

    return Object.fromEntries(
      Array.from(value.entries(), ([key, entryValue]) => [
        String(key),
        normalizeJsonValue(entryValue, seen),
      ]),
    );
  }

  if (value instanceof Set) {
    if (markSeen(value, seen)) {
      return "[Circular]";
    }

    return Array.from(value.values(), (entry) => normalizeJsonValue(entry, seen));
  }

  if (!isPlainObject(value)) {
    return String(value);
  }

  if (markSeen(value, seen)) {
    return "[Circular]";
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, normalizeJsonValue(entryValue, seen)]),
  );
}

export function compactTraceAttributes(
  attributes: NonNullable<Parameters<Tracer.Span["event"]>[2]>,
): TraceAttributes {
  const entries: Array<[string, Schema.Json]> = [];

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      entries.push([key, normalizeJsonValue(value)]);
    }
  }

  return Object.fromEntries(entries);
}

export function formatTraceExit(exit: Exit.Exit<unknown, unknown>): EffectTraceRecord["exit"] {
  if (ExitRuntime.isSuccess(exit)) {
    return TraceExit.Success();
  }

  if (Cause.hasInterruptsOnly(exit.cause)) {
    return TraceExit.Interrupted({ cause: Cause.pretty(exit.cause) });
  }

  return TraceExit.Failure({ cause: Cause.pretty(exit.cause) });
}

const TRACE_ATTRIBUTE_MAX_LENGTH = 500;

const TRACE_ATTRIBUTE_TRUNCATED_LENGTH = 200;

const TRACE_ATTRIBUTE_TRUNCATION_SUFFIX = "…[truncated]";

const ALWAYS_TRUNCATED_TRACE_ATTRIBUTES: ReadonlySet<string> = new Set(["db.query.text"]);

// Clamps strings nested inside already-normalized attribute values (arrays and
// plain objects from normalizeJsonValue, e.g. an Error's `stack`). Returns the
// input reference when nothing was clamped.
function truncateNestedValue(value: Schema.Json): Schema.Json {
  if (Predicate.isString(value)) {
    return value.length <= TRACE_ATTRIBUTE_MAX_LENGTH
      ? value
      : `${value.slice(0, TRACE_ATTRIBUTE_MAX_LENGTH)}${TRACE_ATTRIBUTE_TRUNCATION_SUFFIX}`;
  }

  if (Array.isArray(value)) {
    const truncated = value.map(truncateNestedValue);

    return truncated.some((entry, index) => entry !== value[index]) ? truncated : value;
  }

  if (isJsonObject(value)) {
    let truncated: Record<string, Schema.Json> | undefined;

    for (const [key, entry] of Object.entries(value)) {
      const next = truncateNestedValue(entry);

      if (next === entry) continue;
      truncated ??= { ...value };
      truncated[key] = next;
    }

    return truncated ?? value;
  }

  return value;
}

/**
 * Clamps oversized attribute values on the serialized trace record so the file
 * sink stays small, including strings nested inside arrays and objects (e.g.
 * error stacks). Returns a new record when anything was clamped; never
 * mutates the input (the live span's attributes are shared with other tracers).
 */
export function truncateTraceAttributes(attributes: TraceAttributes): TraceAttributes {
  let truncated: Record<string, Schema.Json> | undefined;

  for (const [key, value] of Object.entries(attributes)) {
    if (Predicate.isString(value) && ALWAYS_TRUNCATED_TRACE_ATTRIBUTES.has(key)) {
      if (value.length <= TRACE_ATTRIBUTE_TRUNCATED_LENGTH) continue;
      truncated ??= { ...attributes };
      truncated[key] =
        `${value.slice(0, TRACE_ATTRIBUTE_TRUNCATED_LENGTH)}${TRACE_ATTRIBUTE_TRUNCATION_SUFFIX}`;
      continue;
    }

    const next = truncateNestedValue(value);

    if (next === value) continue;
    truncated ??= { ...attributes };
    truncated[key] = next;
  }

  return truncated ?? attributes;
}

function isJsonObject(value: Schema.Json): value is Schema.JsonObject {
  return Predicate.isObject(value);
}
