import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createMigratingStorage, readMigratedLocalStorage } from "./storageKeyMigration";
import type { StateStorage } from "./storage";

const NEW_KEY = "akeru:test";
const LEGACY_KEY = "t3code:test";

function makeStorage(initial?: Record<string, string>) {
  const store = new Map(Object.entries(initial ?? {}));
  const backing: StateStorage = {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
  return { store, backing };
}

describe("createMigratingStorage", () => {
  it("reads synchronous storage synchronously", () => {
    const { backing } = makeStorage({ [LEGACY_KEY]: "old" });
    const storage = createMigratingStorage(backing, NEW_KEY, LEGACY_KEY);
    expect(storage.getItem(NEW_KEY)).toBe("old");
  });

  it("reads the legacy key when the new key is empty", async () => {
    const { backing } = makeStorage({ [LEGACY_KEY]: "old" });
    const storage = createMigratingStorage(backing, NEW_KEY, LEGACY_KEY);
    expect(await storage.getItem(NEW_KEY)).toBe("old");
  });

  it("reads the legacy key from asynchronous storage", async () => {
    const { backing } = makeStorage({ [LEGACY_KEY]: "old" });
    const asyncBacking: StateStorage = {
      ...backing,
      getItem: async (name) => backing.getItem(name),
    };
    const storage = createMigratingStorage(asyncBacking, NEW_KEY, LEGACY_KEY);
    expect(await storage.getItem(NEW_KEY)).toBe("old");
  });

  it("removes the legacy key only after the new write succeeds", async () => {
    const { store, backing } = makeStorage({ [LEGACY_KEY]: "old" });
    const storage = createMigratingStorage(backing, NEW_KEY, LEGACY_KEY);
    await storage.setItem(NEW_KEY, "new");
    expect(store.get(NEW_KEY)).toBe("new");
    expect(store.has(LEGACY_KEY)).toBe(false);
  });

  it("keeps the legacy value when the new write rejects", async () => {
    const { store, backing } = makeStorage({ [LEGACY_KEY]: "old" });
    const failing: StateStorage = {
      ...backing,
      setItem: () => Promise.reject(new Error("quota exceeded")),
    };
    const storage = createMigratingStorage(failing, NEW_KEY, LEGACY_KEY);
    await expect(storage.setItem(NEW_KEY, "new")).rejects.toThrow("quota exceeded");
    expect(store.get(LEGACY_KEY)).toBe("old");
    expect(store.has(NEW_KEY)).toBe(false);
  });

  it("surfaces a successful write even when legacy cleanup rejects", async () => {
    const { store, backing } = makeStorage({ [LEGACY_KEY]: "old" });
    const failingRemove: StateStorage = {
      ...backing,
      removeItem: () => Promise.reject(new Error("storage locked")),
    };
    const storage = createMigratingStorage(failingRemove, NEW_KEY, LEGACY_KEY);
    await expect(storage.setItem(NEW_KEY, "new")).resolves.toBeUndefined();
    expect(store.get(NEW_KEY)).toBe("new");
    expect(store.get(LEGACY_KEY)).toBe("old");
  });
});

describe("readMigratedLocalStorage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads restricted storage as empty instead of throwing", () => {
    const denied = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.stubGlobal("window", {
      localStorage: { getItem: denied, setItem: denied, removeItem: denied },
    });
    expect(readMigratedLocalStorage(NEW_KEY, LEGACY_KEY)).toBeNull();
  });

  it("copies the legacy value forward", () => {
    const store = new Map([[LEGACY_KEY, "old"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (name: string) => store.get(name) ?? null,
        setItem: (name: string, value: string) => store.set(name, value),
        removeItem: (name: string) => store.delete(name),
      },
    });
    expect(readMigratedLocalStorage(NEW_KEY, LEGACY_KEY)).toBe("old");
    expect(store.get(NEW_KEY)).toBe("old");
    expect(store.has(LEGACY_KEY)).toBe(false);
  });
});
