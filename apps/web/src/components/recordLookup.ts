function hasKey<T extends object>(record: T, key: PropertyKey): key is keyof T {
  return Object.hasOwn(record, key);
}

/** Looks up a dynamic key without widening a finite table to an open dictionary. */
export function recordLookup<T extends object>(
  record: T,
  key: PropertyKey,
): T[keyof T] | undefined {
  return hasKey(record, key) ? record[key] : undefined;
}
