import {
  AUTOMATIC_READOUT_STORAGE_KEY,
  decodeAutomaticReadoutPreference,
} from "./automaticReadout.ts";

export interface ReplyReadoutStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Stores only the opt-in boolean on this client, never reply text or audio. */
export function createReplyReadoutPreference(storage: ReplyReadoutStorage, onDisable: () => void) {
  let snapshot = { enabled: false, persistenceError: false };
  let revision = 0;
  let writes = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (enabled: boolean, persistenceError: boolean) => {
    snapshot = { enabled, persistenceError };
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: async () => {
      const current = revision;
      try {
        const value = await storage.getItem(AUTOMATIC_READOUT_STORAGE_KEY);
        if (current === revision) publish(decodeAutomaticReadoutPreference(value), false);
      } catch {
        if (current === revision) publish(false, true);
      }
    },
    setEnabled: (enabled: boolean) => {
      revision += 1;
      const current = revision;
      if (!enabled) onDisable();
      publish(enabled, false);
      writes = writes.then(async () => {
        try {
          await storage.setItem(AUTOMATIC_READOUT_STORAGE_KEY, String(enabled));
        } catch {
          if (current === revision) publish(enabled, true);
        }
      });
      return writes;
    },
  };
}

export type ReplyReadoutPreference = ReturnType<typeof createReplyReadoutPreference>;
