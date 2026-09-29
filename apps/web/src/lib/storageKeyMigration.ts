import type { StateStorage } from "./storage";

/**
 * Web persisted state moved from the upstream `t3code:` prefix to `akeru:`.
 * The wrapped storage reads the legacy key when the new key is empty, and the
 * first write to the new key removes the legacy entry, so existing installs
 * keep their data without a one-shot migration pass.
 */
export function createMigratingStorage(
  storage: StateStorage,
  key: string,
  legacyKey: string,
): StateStorage {
  return {
    getItem: async (name) => {
      const value = await storage.getItem(name);
      if (value !== null) return value;
      return name === key ? storage.getItem(legacyKey) : null;
    },
    setItem: (name, value) =>
      // Retire the legacy entry only after the new write lands; a rejected
      // write must keep the last durable copy under the old key.
      Promise.resolve(storage.setItem(name, value)).then(() => {
        if (name === key) {
          return Promise.resolve(storage.removeItem(legacyKey)).catch(() => {
            // A failed cleanup leaves a harmless duplicate behind.
          });
        }
      }),
    removeItem: (name) => {
      const result = storage.removeItem(name);
      if (name === key) storage.removeItem(legacyKey);
      return result;
    },
  };
}

/** Read-through migration for single-value keys: returns the new value, or
 * the legacy value copied forward when only the old key exists. */
export function readMigratedLocalStorage(key: string, legacyKey: string): string | null {
  if (typeof window === "undefined") return null;
  const storage = window.localStorage;
  const value = storage.getItem(key);
  if (value !== null) return value;
  const legacy = storage.getItem(legacyKey);
  if (legacy === null) return null;
  try {
    storage.setItem(key, legacy);
    storage.removeItem(legacyKey);
  } catch {
    // Quota errors still allow the read to succeed.
  }
  return legacy;
}

/** Copy a `t3code:` value forward once; used by hooks that read a flag before
 * their `useLocalStorage` write path runs. */
export function migrateLocalStorageKey(key: string, legacyKey: string): void {
  readMigratedLocalStorage(key, legacyKey);
}
