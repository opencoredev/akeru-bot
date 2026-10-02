import * as P from "effect/Predicate";

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export function deepMerge<T extends Record<string, unknown>>(current: T, patch: DeepPartial<T>): T {
  if (!P.isObject(current) || !P.isObject(patch)) {
    // SAFETY: Valid record inputs take the object branch; this preserves whole-value replacement for unchecked primitive callers.
    return patch as T;
  }

  const next = { ...current };

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    const existing = next[key];
    Object.assign(next, {
      [key]: P.isObject(existing) && P.isObject(value) ? deepMerge(existing, value) : value,
    });
  }

  return next;
}
