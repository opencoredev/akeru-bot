import * as Predicate from "effect/Predicate";
import * as NodeCrypto from "node:crypto";

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- This canonical JSON walker must preserve arbitrary metadata values until JSON serialization.
export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);

  if (value === null || !Predicate.isObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export function canonicalJson<Value>(value: Value): string {
  return JSON.stringify(canonicalValue(value));
}

export function portabilityChecksum<Value>(value: Value): string {
  return NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}
