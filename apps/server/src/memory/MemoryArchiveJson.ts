import * as Predicate from "effect/Predicate";

const canonicalize = <Value>(value: Value): Value | object => {
  if (Array.isArray(value)) return value.map(canonicalize);

  if (!Predicate.isObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
};

export const encodeMemoryArchiveJson = <Value>(value: Value): string =>
  JSON.stringify(canonicalize(value));
