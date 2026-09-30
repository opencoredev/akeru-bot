import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({}));

import { MobileDatabase, MobileDatabaseError, type StoredPreferencesJson } from "./mobile-database";
import { make } from "./mobile-preferences";
import { MobileSecureStorage } from "./mobile-secure-storage";

describe("mobile preferences fallback migration", () => {
  it.effect("retires a legacy fallback after the database stores a newer value", () =>
    Effect.gen(function* () {
      const secure = new Map<string, string>([
        [
          "t3code.preferences.fallback",
          JSON.stringify({ payload: JSON.stringify({ baseFontSize: 17 }), updatedAt: 17 }),
        ],
      ]);
      let available = true;
      let stored: StoredPreferencesJson | null = null;
      const outage = new MobileDatabaseError({ operation: "load-preferences", cause: "offline" });
      const database = MobileDatabase.of({
        loadCache: () => Effect.succeed(Option.none()),
        saveCache: () => Effect.void,
        removeCache: () => Effect.void,
        clearCacheKind: () => Effect.void,
        clearEnvironmentCache: () => Effect.void,
        clearAllCaches: Effect.void,
        inspectCaches: Effect.succeed([]),
        loadPreferencesJson: Effect.suspend(() =>
          available
            ? Effect.succeed(Option.fromUndefinedOr(stored ?? undefined))
            : Effect.fail(outage),
        ),
        savePreferencesJson: (payload, updatedAt) =>
          Effect.sync(() => {
            stored = { payload, updatedAt };
          }),
      });
      const secureStorage = MobileSecureStorage.of({
        getItem: (key) => Effect.sync(() => secure.get(key) ?? null),
        setItem: (key, value) => Effect.sync(() => void secure.set(key, value)),
        removeItem: (key) => Effect.sync(() => void secure.delete(key)),
      });
      const preferences = yield* make().pipe(
        Effect.provideService(MobileDatabase, database),
        Effect.provideService(MobileSecureStorage, secureStorage),
      );

      expect((yield* preferences.load).baseFontSize).toBe(17);
      expect(secure.has("t3code.preferences.fallback")).toBe(false);
      yield* preferences.savePatch({ baseFontSize: 20 });
      available = false;
      expect((yield* preferences.load).baseFontSize).not.toBe(17);
    }),
  );
});
