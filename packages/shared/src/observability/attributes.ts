import * as Predicate from "effect/Predicate";
import * as Cause from "effect/Cause";
import type * as Exit from "effect/Exit";
import * as ExitRuntime from "effect/Exit";
import * as Option from "effect/Option";
import { type TraceAttributes, type EffectTraceRecord } from "./types.ts";

function isStructuralTag(value: unknown): value is string {
  return (
    Predicate.isString(value) &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z][A-Za-z0-9._:/-]*$/.test(value)
  );
}

export function errorTag(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null && "_tag" in error) {
      return isStructuralTag(error._tag) ? error._tag : "TaggedError";
    }

    if (error instanceof Error) {
      return isStructuralTag(error.name) ? error.name : "Error";
    }
  } catch {
    return "UnknownError";
  }

  return typeof error;
}

export function causeErrorTag(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findErrorOption(cause);

  if (Option.isSome(failure)) {
    return errorTag(failure.value);
  }

  return cause.reasons[0]?._tag ?? "Empty";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markSeen(value: object, seen: WeakSet<object>): boolean {
  if (seen.has(value)) {
    return true;
  }

  seen.add(value);

  return false;
}

function normalizeJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
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
  attributes: Readonly<Record<string, unknown>>,
): TraceAttributes {
  const entries: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      entries.push([key, normalizeJsonValue(value)]);
    }
  }

  return Object.fromEntries(entries);
}

export function formatTraceExit(exit: Exit.Exit<unknown, unknown>): EffectTraceRecord["exit"] {
  if (ExitRuntime.isSuccess(exit)) {
    return { _tag: "Success" };
  }

  if (Cause.hasInterruptsOnly(exit.cause)) {
    return {
      _tag: "Interrupted",
      cause: Cause.pretty(exit.cause),
    };
  }

  return {
    _tag: "Failure",
    cause: Cause.pretty(exit.cause),
  };
}

const TRACE_ATTRIBUTE_MAX_LENGTH = 500;

const TRACE_ATTRIBUTE_TRUNCATED_LENGTH = 200;

const TRACE_ATTRIBUTE_TRUNCATION_SUFFIX = "…[truncated]";

const ALWAYS_TRUNCATED_TRACE_ATTRIBUTES: ReadonlySet<string> = new Set(["db.query.text"]);

// Clamps strings nested inside already-normalized attribute values (arrays and
// plain objects from normalizeJsonValue, e.g. an Error's `stack`). Returns the
// input reference when nothing was clamped.
function truncateNestedValue(value: unknown): unknown {
  if (Predicate.isString(value)) {
    return value.length <= TRACE_ATTRIBUTE_MAX_LENGTH
      ? value
      : `${value.slice(0, TRACE_ATTRIBUTE_MAX_LENGTH)}${TRACE_ATTRIBUTE_TRUNCATION_SUFFIX}`;
  }

  if (Array.isArray(value)) {
    const truncated = value.map(truncateNestedValue);

    return truncated.some((entry, index) => entry !== value[index]) ? truncated : value;
  }

  if (isPlainObject(value)) {
    let truncated: Record<string, unknown> | undefined;

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
  let truncated: Record<string, unknown> | undefined;

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
