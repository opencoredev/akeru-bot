export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

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

export function projectBoundedValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return copyTruncatedString(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_PROJECTED_VALUE_DEPTH) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_PROJECTED_ARRAY_LENGTH)
      .map((entry) => projectBoundedValue(entry, depth + 1));
  }

  const projected: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value).slice(0, MAX_PROJECTED_OBJECT_KEYS)) {
    projected[key] = projectBoundedValue(entry, depth + 1);
  }

  return projected;
}
