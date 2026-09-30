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
    // Stays synchronous over synchronous storage so persisted stores still
    // hydrate before their first render.
    getItem: (name) => {
      const orLegacy = (value: string | null) =>
        value !== null ? value : name === key ? storage.getItem(legacyKey) : null;
      const value = storage.getItem(name);
      return value instanceof Promise ? value.then(orLegacy) : orLegacy(value);
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
  // `window` can exist without `localStorage` (node-style test environments,
  // disabled storage), and restricted storage can throw on read. Both read as
  // empty so module-load callers keep working.
  let storage: Storage;
  let legacy: string | null;
  try {
    const available = typeof window === "undefined" ? undefined : window.localStorage;
    if (available === undefined || available === null) return null;
    storage = available;
    const value = storage.getItem(key);
    if (value !== null) return value;
    legacy = storage.getItem(legacyKey);
  } catch {
    return null;
  }
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
