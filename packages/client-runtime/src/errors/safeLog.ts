import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

const SAFE_ERROR_LABEL =
  /^(?:Error|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError|AggregateError|DOMException|[A-Za-z][A-Za-z0-9]*(?:Error|Failure))$/;

const SAFE_TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const STACK_FRAME_LIMIT = 32;

export interface SafeErrorLogAttributes {
  readonly errorType: "error" | "array" | "null" | "object" | "primitive";
  readonly errorName?: string;
  readonly errorTag?: string;
  readonly traceId?: string;
  readonly stack?: string;
}

const decodeSafeLabel = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isPattern(SAFE_ERROR_LABEL)),
);

const readSafeLabel = flow(decodeSafeLabel, Option.getOrUndefined);

function sanitizeStackUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";

    return url.toString();
  } catch {
    return value;
  }
}

function sanitizeStackFrame(frame: string): string {
  return frame.replace(/(?:https?|file):\/\/[^\s)]+/g, sanitizeStackUrl);
}

function readSafeStack(error: Error): string | undefined {
  try {
    const frames = error.stack
      ?.split(/\r?\n/)
      .filter((line) => /^\s*at\s+/.test(line) || /^[^@\s]+@(?:https?|file):\/\//.test(line))
      .slice(0, STACK_FRAME_LIMIT)
      .map(sanitizeStackFrame);

    return frames && frames.length > 0 ? frames.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

function readErrorTag(cause: unknown): string | undefined {
  try {
    if (!Predicate.isObjectOrArray(cause)) {
      return undefined;
    }

    return readSafeLabel(Predicate.hasProperty(cause, "_tag") ? cause._tag : undefined);
  } catch {
    return undefined;
  }
}

function readTraceId(cause: unknown): string | undefined {
  try {
    const seen = new Set<object>();
    let current: unknown = cause;

    while (Predicate.isObjectOrArray(current) && !seen.has(current)) {
      seen.add(current);
      const record = current;

      if (
        Predicate.hasProperty(record, "traceId") &&
        Predicate.isString(record.traceId) &&
        SAFE_TRACE_ID.test(record.traceId)
      ) {
        return record.traceId;
      }

      current = Predicate.hasProperty(record, "cause") ? record.cause : undefined;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export function safeErrorLogAttributes(cause: unknown): SafeErrorLogAttributes {
  const errorTag = readErrorTag(cause);
  const traceId = readTraceId(cause);

  if (cause instanceof Error) {
    const errorName = readSafeLabel(cause.name);
    const stack = readSafeStack(cause);

    return {
      errorType: "error",
      ...(errorName !== undefined ? { errorName } : {}),
      ...(errorTag !== undefined ? { errorTag } : {}),
      ...(traceId !== undefined ? { traceId } : {}),
      ...(stack !== undefined ? { stack } : {}),
    };
  }

  return {
    errorType:
      cause === null
        ? "null"
        : Array.isArray(cause)
          ? "array"
          : Predicate.isObjectOrArray(cause) || cause === null
            ? "object"
            : "primitive",
    ...(errorTag !== undefined ? { errorTag } : {}),
    ...(traceId !== undefined ? { traceId } : {}),
  };
}
