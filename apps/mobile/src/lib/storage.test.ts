import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  let preferencesJson: string | null = null;
  let preferencesUpdatedAt = 0;
  let loadPreferencesFails = false;
  let savePreferencesFails = false;
  return {
    clear: () => {
      values.clear();
      preferencesJson = null;
      preferencesUpdatedAt = 0;
      loadPreferencesFails = false;
      savePreferencesFails = false;
    },
    getStoredValue: (key: string) => values.get(key) ?? null,
    getPreferencesJson: () => preferencesJson,
    setPreferencesJson: (value: string, updatedAt: number) => {
      preferencesJson = value;
      preferencesUpdatedAt = updatedAt;
    },
    setDatabaseFailures: (load: boolean, save: boolean) => {
      loadPreferencesFails = load;
      savePreferencesFails = save;
    },
    getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItemAsync: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: vi.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
    database: {
      closeAsync: vi.fn(() => Promise.resolve()),
      execAsync: vi.fn(() => Promise.resolve()),
      withExclusiveTransactionAsync: vi.fn(
        (run: (transaction: { execAsync: () => Promise<void> }) => Promise<void>) =>
          run({ execAsync: () => Promise.resolve() }),
      ),
      getFirstAsync: vi.fn((sql: string) => {
        if (sql.includes("PRAGMA user_version")) {
          return Promise.resolve({ user_version: 1 });
        }
        if (loadPreferencesFails) {
          return Promise.reject(new Error("database unavailable"));
        }
        return Promise.resolve(
          preferencesJson === null
            ? null
            : { payload: preferencesJson, updatedAt: preferencesUpdatedAt },
        );
      }),
      runAsync: vi.fn((_sql: string, payload?: unknown, updatedAt?: unknown) => {
        if (savePreferencesFails) {
          return Promise.reject(new Error("database unavailable"));
        }
        if (typeof payload === "string") {
          preferencesJson = payload;
        }
        if (typeof updatedAt === "number") {
          preferencesUpdatedAt = updatedAt;
        }
        return Promise.resolve();
      }),
    },
  };
});

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: mocks.deleteItemAsync,
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
}));

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: vi.fn(() => Promise.resolve(mocks.database)),
}));

vi.mock("expo-crypto", () => ({
  getRandomBytes: vi.fn(() => new Uint8Array(16)),
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

import {
  clearAgentAwarenessRegistrationRecord,
  loadPreferences,
  loadSavedConnections,
  savePreferencesPatch,
} from "../persistence/imperative";

describe("mobile connection storage", () => {
  beforeEach(() => {
    mocks.clear();
    vi.clearAllMocks();
  });

  it("preserves secure-storage read failures with operation and key context", async () => {
    const cause = new Error("keychain unavailable");
    mocks.getItemAsync.mockRejectedValueOnce(cause);

    await expect(loadSavedConnections()).rejects.toMatchObject({
      _tag: "MobileSecureStorageError",
      operation: "read",
      key: "akeru.connections",
      cause,
      message: "Mobile secure storage operation read failed for key akeru.connections.",
    });
  });

  it("retires legacy registration data after a direct clear", async () => {
    await mocks.setItemAsync("t3code.agent-awareness.registration", "stale");

    await clearAgentAwarenessRegistrationRecord();

    expect(mocks.getStoredValue("akeru.agent-awareness.registration")).toBe("");
    expect(mocks.getStoredValue("t3code.agent-awareness.registration")).toBeNull();
  });

  it("logs structured decode failures before using the empty fallback", async () => {
    await mocks.setItemAsync("akeru.connections", "{");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadSavedConnections()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "[mobile-storage] ignored invalid JSON",
      expect.objectContaining({
        _tag: "MobileStorageDecodeError",
        key: "akeru.connections",
        cause: expect.any(SyntaxError),
        message: "Failed to decode mobile storage value for key akeru.connections.",
      }),
    );

    warn.mockRestore();
  });

  it("loads legacy preferences when SQLite is unavailable", async () => {
    mocks.setDatabaseFailures(true, true);
    await mocks.setItemAsync("akeru.preferences", JSON.stringify({ baseFontSize: 17 }));

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 17 });
  });

  it("canonicalizes legacy t3-code and t3-chat theme ids on load", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        themeId: "t3-code",
        lightThemeId: "t3-chat",
        darkThemeId: "t3-code",
        themeMode: "system",
      }),
      10,
    );

    await expect(loadPreferences()).resolves.toEqual({
      themeId: "akeru-classic",
      lightThemeId: "akeru-chat",
      darkThemeId: "akeru-classic",
      themeMode: "system",
    });
  });

  it("persists language locally and resets to system without changing other preferences", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 17 }), 10);
    await expect(savePreferencesPatch({ language: "en" })).resolves.toEqual({
      baseFontSize: 17,
      language: "en",
    });
    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 17, language: "en" });
    await expect(savePreferencesPatch({ language: "system" })).resolves.toEqual({
      baseFontSize: 17,
      language: "system",
    });
    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 17, language: "system" });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({
      baseFontSize: 17,
      language: "system",
    });
  });

  it("ignores malformed language preferences", async () => {
    mocks.setPreferencesJson(JSON.stringify({ language: { locale: "en" }, baseFontSize: 17 }), 10);
    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 17 });
  });

  it("retains language in the device-local fallback when SQLite is unavailable", async () => {
    mocks.setDatabaseFailures(true, true);
    await expect(savePreferencesPatch({ language: "en" })).resolves.toEqual({ language: "en" });
    await expect(loadPreferences()).resolves.toEqual({ language: "en" });
  });

  it("persists independent light and dark theme choices", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        themeId: "grove",
        lightThemeId: "iris",
        darkThemeId: "ocean",
        themeMode: "system",
      }),
      10,
    );

    await expect(loadPreferences()).resolves.toEqual({
      themeId: "grove",
      lightThemeId: "iris",
      darkThemeId: "ocean",
      themeMode: "system",
    });
  });

  it("falls back to secure storage when SQLite cannot save preferences", async () => {
    mocks.setDatabaseFailures(true, true);
    await expect(savePreferencesPatch({ baseFontSize: 19 })).resolves.toEqual({ baseFontSize: 19 });
    const fallback = JSON.parse(mocks.getStoredValue("akeru.preferences.fallback") ?? "") as {
      readonly payload: string;
      readonly updatedAt: number;
    };
    expect(JSON.parse(fallback.payload)).toEqual({ baseFontSize: 19 });
    expect(fallback.updatedAt).toEqual(expect.any(Number));
  });

  it("persists Thread List v2 shelf expansion preferences", async () => {
    await expect(
      savePreferencesPatch({
        threadListV2SettledShelfExpanded: false,
        threadListV2SnoozedShelfExpanded: true,
      }),
    ).resolves.toEqual({
      threadListV2SettledShelfExpanded: false,
      threadListV2SnoozedShelfExpanded: true,
    });

    await expect(loadPreferences()).resolves.toEqual({
      threadListV2SettledShelfExpanded: false,
      threadListV2SnoozedShelfExpanded: true,
    });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({
      threadListV2SettledShelfExpanded: false,
      threadListV2SnoozedShelfExpanded: true,
    });
  });

  it("ignores invalid Thread List v2 shelf expansion preference types", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        baseFontSize: 17,
        threadListV2SettledShelfExpanded: "false",
        threadListV2SnoozedShelfExpanded: 1,
      }),
      10,
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 17 });
  });

  it("reconciles fallback preferences after SQLite recovers", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 15 }), 10);
    await mocks.setItemAsync(
      "akeru.preferences.fallback",
      JSON.stringify({
        payload: JSON.stringify({ baseFontSize: 19 }),
        updatedAt: 20,
      }),
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 19 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 19 });
    expect(mocks.getStoredValue("akeru.preferences.fallback")).toBeNull();
  });

  it("ignores a stale fallback when its previous deletion failed", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync(
      "akeru.preferences.fallback",
      JSON.stringify({
        payload: JSON.stringify({ baseFontSize: 19 }),
        updatedAt: 20,
      }),
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
    expect(mocks.getStoredValue("akeru.preferences.fallback")).toBeNull();
  });

  it("ignores an invalid fallback even when it has a newer timestamp", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync(
      "akeru.preferences.fallback",
      JSON.stringify({ payload: "{", updatedAt: 40 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
    expect(mocks.getStoredValue("akeru.preferences.fallback")).toBeNull();

    warn.mockRestore();
  });

  it("keeps SQLite authoritative when stale legacy preferences remain", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync("akeru.preferences", JSON.stringify({ baseFontSize: 19 }));

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
  });
});
