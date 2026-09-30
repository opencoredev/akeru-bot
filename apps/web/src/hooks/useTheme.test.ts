import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("theme failure handling", () => {
  it("keeps a saved theme successful when legacy cleanup fails", async () => {
    const storage = createStorage({
      removeItem: () => {
        throw new Error("storage remove blocked");
      },
    });
    vi.stubGlobal("window", { localStorage: storage });
    const { readThemePreference, writeThemePreference } = await import("./useTheme");

    expect(() => writeThemePreference("dark")).not.toThrow();
    expect(readThemePreference()).toBe("dark");
  });

  it("preserves exact storage causes and operation context", async () => {
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw readCause;
        },
        setItem: () => {
          throw writeCause;
        },
      }),
    });

    const { readThemePreference, ThemeStorageError, writeThemePreference } =
      await import("./useTheme");

    try {
      readThemePreference();
      expect.unreachable("expected the theme read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "read",
        storageKey: "akeru:theme",
        cause: readCause,
      });
    }

    try {
      writeThemePreference("dark");
      expect.unreachable("expected the theme write to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ThemeStorageError);
      expect(error).toMatchObject({
        operation: "write",
        storageKey: "akeru:theme",
        theme: "dark",
        cause: writeCause,
      });
    }
  });

  it("keeps a mix saved only under the legacy key when a theme change fails", async () => {
    const storage = createStorage();
    storage.setItem("t3code:theme-halves:v1", JSON.stringify({ dark: "grove" }));
    const setItem = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      if (key === "akeru:theme") throw new Error("storage quota exceeded");
      setItem(key, value);
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    }));
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: storage,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });

    const { readThemeHalves, useTheme } = await import("./useTheme");
    const before = readThemeHalves();

    expect(before).not.toBeNull();
    expect(useTheme().setTheme("akeru-paper")).toBe(false);
    expect(readThemeHalves()).toEqual(before);
  });

  it("uses Akeru Paper for a fresh profile", async () => {
    vi.stubGlobal("window", { localStorage: createStorage() });

    const { readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("akeru-paper");
  });

  it("migrates the old system default to Akeru Paper", async () => {
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: (key) => (key === "akeru:theme" ? "system" : null),
      }),
    });

    const { readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("akeru-paper");
  });

  it("reads the persisted T3 Chat theme preference", async () => {
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => "akeru-chat",
      }),
    });

    const { readThemePreference } = await import("./useTheme");

    expect(readThemePreference()).toBe("akeru-chat");
  });

  it("falls back during initial theme application and logs only safe attributes", async () => {
    const cause = new Error("private browsing storage failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("window", {
      localStorage: createStorage({
        getItem: () => {
          throw cause;
        },
      }),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle: vi.fn() },
      },
    });

    await expect(import("./useTheme")).resolves.toBeDefined();

    expect(errorLog).toHaveBeenCalledWith(
      "Failed to read theme preference for akeru:theme.",
      expect.objectContaining({
        operation: "read",
        storageKey: "akeru:theme",
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    const cause = new Error("persistent storage failure");
    const themeGetItem = vi.fn((): string | null => {
      throw cause;
    });
    const getItem = vi.fn((key: string) => (key === "akeru:theme" ? themeGetItem() : null));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let readSnapshot: (() => unknown) | undefined;
    let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
    let storageHandler: ((event: StorageEvent) => void) | undefined;
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => {
        subscribeToTheme = subscribe;
        readSnapshot = getSnapshot;
        return getSnapshot();
      },
    }));
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
        if (type === "storage") storageHandler = listener;
      },
      localStorage: createStorage({ getItem }),
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");
    useTheme();
    readSnapshot?.();
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToTheme?.(() => undefined);
    storageHandler?.({ key: "akeru:theme" } as StorageEvent);
    readSnapshot?.();

    expect(themeGetItem).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(2);
    unsubscribe?.();
  });

  it("preserves desktop sync causes and retries after a failed cosmetic sync", async () => {
    const cause = new Error("desktop IPC unavailable");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTheme = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", { desktopBridge: { setTheme } });

    const { DesktopThemeSyncError, syncDesktopTheme, syncDesktopThemePreference } =
      await import("./useTheme");

    const error = await syncDesktopThemePreference({ setTheme }, "dark").then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(DesktopThemeSyncError);
    expect(error).toMatchObject({ theme: "dark", cause });

    setTheme.mockClear();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();
    syncDesktopTheme("dark");
    await Promise.resolve();
    await Promise.resolve();

    expect(setTheme).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the dark theme to the desktop shell.",
      expect.objectContaining({
        theme: "dark",
        errorTag: "DesktopThemeSyncError",
      }),
    );
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });
});

describe("legacy key cleanup", () => {
  function legacyThrowingStorage(initial: Record<string, string> = {}): Storage {
    const store = new Map(Object.entries(initial));
    return createStorage({
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        if (key.startsWith("t3code:")) throw new Error("legacy removal blocked");
        store.delete(key);
      },
    });
  }

  function mockReactStore() {
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (
        _subscribe: (listener: () => void) => () => void,
        getSnapshot: () => unknown,
      ) => getSnapshot(),
    }));
  }

  it("keeps the theme preference write when legacy cleanup throws", async () => {
    const storage = legacyThrowingStorage({ "t3code:theme": "akeru-chat" });
    vi.stubGlobal("window", { localStorage: storage });

    const { writeThemePreference } = await import("./useTheme");

    expect(() => writeThemePreference("ocean")).not.toThrow();
    expect(storage.getItem("akeru:theme")).toBe("ocean");
  });

  it("keeps the appearance mode write when legacy cleanup throws", async () => {
    const storage = legacyThrowingStorage();
    mockReactStore();
    vi.stubGlobal("window", {
      localStorage: storage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");

    expect(useTheme().setAppearanceMode("dark")).toBe(true);
    expect(storage.getItem("akeru:theme-appearance-mode")).toBe("dark");
  });

  it("keeps the theme half write when legacy cleanup throws", async () => {
    const storage = legacyThrowingStorage();
    mockReactStore();
    vi.stubGlobal("window", {
      localStorage: storage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");

    expect(useTheme().setThemeHalf("light", "ocean")).toBe(true);
    expect(storage.getItem("akeru:theme-halves:v1")).toBe(JSON.stringify({ light: "ocean" }));
  });

  it("keeps the theme choice when legacy cleanup throws", async () => {
    const storage = legacyThrowingStorage({
      "akeru:theme-halves:v1": JSON.stringify({ light: "ocean" }),
    });
    mockReactStore();
    vi.stubGlobal("window", {
      localStorage: storage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");

    expect(useTheme().setTheme("grove")).toBe(true);
    expect(storage.getItem("akeru:theme")).toBe("grove");
    expect(storage.getItem("akeru:theme-halves:v1")).toBeNull();
  });

  it("does not revive a legacy mix after choosing a whole theme or clearing the last half", async () => {
    const storage = legacyThrowingStorage({
      "t3code:theme-halves:v1": JSON.stringify({ dark: "grove" }),
    });
    mockReactStore();
    vi.stubGlobal("window", {
      localStorage: storage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });

    const { readThemeHalves, useTheme } = await import("./useTheme");

    expect(useTheme().setTheme("ocean")).toBe(true);
    expect(storage.getItem("akeru:theme")).toBe("ocean");
    expect(readThemeHalves()).toBeNull();

    expect(useTheme().setThemeHalf("light", "ember")).toBe(true);
    expect(useTheme().setThemeHalf("light", null)).toBe(true);
    expect(readThemeHalves()).toBeNull();
  });

  it("keeps cleared theme halves when legacy cleanup throws", async () => {
    const storage = legacyThrowingStorage({
      "akeru:theme-halves:v1": JSON.stringify({ light: "ocean" }),
      "t3code:theme-halves:v1": JSON.stringify({ dark: "ember" }),
    });
    mockReactStore();
    vi.stubGlobal("window", {
      localStorage: storage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });

    const { readThemeHalves, useTheme } = await import("./useTheme");

    expect(useTheme().clearThemeHalves()).toBe(true);
    expect(readThemeHalves()).toBeNull();
  });

  it("removes the current mix key when no legacy mix remains", async () => {
    const storage = legacyThrowingStorage({
      "akeru:theme-halves:v1": JSON.stringify({ light: "ocean" }),
    });
    mockReactStore();
    vi.stubGlobal("window", {
      localStorage: storage,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });

    const { useTheme } = await import("./useTheme");

    expect(useTheme().clearThemeHalves()).toBe(true);
    expect(storage.getItem("akeru:theme-halves:v1")).toBeNull();
  });
});
