import * as Predicate from "effect/Predicate";
import * as NodeCrypto from "node:crypto";

export function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);

  if (value === null || !Predicate.isObjectOrArray(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function portabilityChecksum(value: unknown): string {
  return NodeCrypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}
