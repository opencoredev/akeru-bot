import * as Predicate from "effect/Predicate";

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- This canonical JSON walker preserves arbitrary archive metadata until JSON serialization.
const canonicalize = (value: unknown): unknown => {
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
