import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const ActivityRecord = Schema.Record(Schema.String, Schema.Unknown);

export type ActivityRecord = {
  -readonly [Key in keyof typeof ActivityRecord.Type]: (typeof ActivityRecord.Type)[Key];
};

export type ActivityValue = ActivityRecord[string];

/** Probe only the outer object; callers narrow the fields they read. */
export function asRecord(value: ActivityValue): ActivityRecord | null {
  return Predicate.isObject(value) ? value : null;
}

export function asTrimmedString(value: ActivityValue): string | null {
  if (!Predicate.isString(value)) return null;
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

const MAX_PROJECTED_VALUE_DEPTH = 4;

const MAX_PROJECTED_STRING_LENGTH = 4_096;

const MAX_PROJECTED_ARRAY_LENGTH = 24;

const MAX_PROJECTED_OBJECT_KEYS = 32;

function copyTruncatedString(value: string): string {
  if (value.length <= MAX_PROJECTED_STRING_LENGTH) {
    return value;
  }

  let prefix = value.slice(0, MAX_PROJECTED_STRING_LENGTH - 1);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);

  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }

  return `${prefix}…`;
}

export function projectBoundedValue(value: ActivityValue, depth = 0): ActivityValue {
  if (Predicate.isString(value)) {
    return copyTruncatedString(value);
  }

  if (
    value === null ||
    value === undefined ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return value;
  }

  if (depth >= MAX_PROJECTED_VALUE_DEPTH) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PROJECTED_ARRAY_LENGTH)
      .map((entry: ActivityValue) => projectBoundedValue(entry, depth + 1));
  }

  const projected: ActivityRecord = {};

  for (const [key, entry] of Object.entries(asRecord(value) ?? {}).slice(
    0,
    MAX_PROJECTED_OBJECT_KEYS,
  )) {
    projected[key] = projectBoundedValue(entry, depth + 1);
  }

  return projected;
}
