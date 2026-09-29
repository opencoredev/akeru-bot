import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import { makeCatalogBackend, makeCatalogStore, migrateLegacyConnectionDatabase } from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});

describe("migrateLegacyConnectionDatabase", () => {
  it.effect("fills missing records without replacing numeric-keyed current data", () =>
    Effect.gen(function* () {
      const fakeIndexedDB = yield* Effect.promise(() =>
        import("fake-indexeddb").then((module) => new module.IDBFactory()),
      );
      vi.stubGlobal("indexedDB", fakeIndexedDB);
      vi.stubGlobal(
        "IDBKeyRange",
        yield* Effect.promise(() => import("fake-indexeddb").then((m) => m.IDBKeyRange)),
      );

      // Seed the legacy database exactly the way the pre-rebrand client did.
      const legacyOpen = indexedDB.open("t3code:connection-runtime", 4);
      const legacy = yield* Effect.promise(
        () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            legacyOpen.addEventListener("upgradeneeded", () => {
              for (const name of ["catalog", "shell", "thread", "server-config", "vcs-refs"]) {
                legacyOpen.result.createObjectStore(name);
              }
            });
            legacyOpen.addEventListener("success", () => resolve(legacyOpen.result));
            legacyOpen.addEventListener("error", () => reject(legacyOpen.error));
          }),
      );
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const tx = legacy.transaction(["catalog", "shell"], "readwrite");
            tx.addEventListener("complete", () => resolve());
            tx.addEventListener("error", () => reject(tx.error));
            tx.objectStore("catalog").put("legacy-catalog-doc", "document");
            tx.objectStore("shell").put("legacy-shell", "env-1");
            tx.objectStore("shell").put("legacy-numeric", 1);
            tx.objectStore("shell").put("legacy-second", 2);
          }),
      );
      legacy.close();

      // Open the new database (empty) the same way the layer does.
      const migratedOpen = indexedDB.open("akeru:connection-runtime", 4);
      const migrated = yield* Effect.promise(
        () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            migratedOpen.addEventListener("upgradeneeded", () => {
              for (const name of ["catalog", "shell", "thread", "server-config", "vcs-refs"]) {
                migratedOpen.result.createObjectStore(name);
              }
            });
            migratedOpen.addEventListener("success", () => resolve(migratedOpen.result));
            migratedOpen.addEventListener("error", () => reject(migratedOpen.error));
          }),
      );

      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const tx = migrated.transaction("shell", "readwrite");
            tx.addEventListener("complete", () => resolve());
            tx.addEventListener("error", () => reject(tx.error));
            tx.objectStore("shell").put("current-numeric", 1);
          }),
      );

      yield* migrateLegacyConnectionDatabase(migrated);

      const read = (store: string, key: IDBValidKey) =>
        Effect.promise(
          () =>
            new Promise<unknown>((resolve, reject) => {
              const request = migrated.transaction(store, "readonly").objectStore(store).get(key);
              request.addEventListener("success", () => resolve(request.result));
              request.addEventListener("error", () => reject(request.error));
            }),
        );

      expect(yield* read("catalog", "document")).toBe("legacy-catalog-doc");
      expect(yield* read("shell", "env-1")).toBe("legacy-shell");
      expect(yield* read("shell", 1)).toBe("current-numeric");
      expect(yield* read("shell", 2)).toBe("legacy-second");
      migrated.close();

      // Legacy database is retired; reopening it yields a fresh empty DB.
      const deletedCheck = indexedDB.open("t3code:connection-runtime", 4);
      let created = false;
      const legacyAfter = yield* Effect.promise(
        () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            deletedCheck.addEventListener("upgradeneeded", () => {
              created = true;
            });
            deletedCheck.addEventListener("success", () => resolve(deletedCheck.result));
            deletedCheck.addEventListener("error", () => reject(deletedCheck.error));
          }),
      );
      expect(created).toBe(true);
      expect(Array.from(legacyAfter.objectStoreNames)).toHaveLength(0);
      legacyAfter.close();
      indexedDB.deleteDatabase("t3code:connection-runtime");
    }),
  );

  it.effect("does not restore records removed after an earlier migration", () =>
    Effect.gen(function* () {
      const fakeIndexedDB = yield* Effect.promise(() =>
        import("fake-indexeddb").then((module) => new module.IDBFactory()),
      );
      vi.stubGlobal("indexedDB", fakeIndexedDB);
      const stores = ["catalog", "shell", "thread", "server-config", "vcs-refs"];
      const open = (name: string) =>
        Effect.promise(
          () =>
            new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open(name, 4);
              request.addEventListener("upgradeneeded", () => {
                for (const store of stores) request.result.createObjectStore(store);
              });
              request.addEventListener("success", () => resolve(request.result));
              request.addEventListener("error", () => reject(request.error));
            }),
        );
      const change = (database: IDBDatabase, apply: (store: IDBObjectStore) => void) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              const tx = database.transaction("shell", "readwrite");
              tx.addEventListener("complete", () => resolve());
              tx.addEventListener("error", () => reject(tx.error));
              apply(tx.objectStore("shell"));
            }),
        );
      const seedLegacy = Effect.gen(function* () {
        const legacy = yield* open("t3code:connection-runtime");
        yield* change(legacy, (store) => store.put("legacy-shell", "env-1"));
        legacy.close();
      });

      yield* seedLegacy;
      const migrated = yield* open("akeru:connection-runtime");
      yield* migrateLegacyConnectionDatabase(migrated);
      yield* change(migrated, (store) => store.delete("env-1"));

      // A blocked deletion leaves the legacy database behind for the next start.
      yield* seedLegacy;
      yield* migrateLegacyConnectionDatabase(migrated);

      const restored = yield* Effect.promise(
        () =>
          new Promise<unknown>((resolve, reject) => {
            const request = migrated
              .transaction("shell", "readonly")
              .objectStore("shell")
              .get("env-1");
            request.addEventListener("success", () => resolve(request.result));
            request.addEventListener("error", () => reject(request.error));
          }),
      );
      expect(restored).toBeUndefined();
      migrated.close();
    }),
  );
});
