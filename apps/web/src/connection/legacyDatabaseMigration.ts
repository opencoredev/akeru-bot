import { hasTag } from "~/lib/taggedUnion";
import { ConnectionTransientError } from "@akeru/client-runtime/connection";
import * as Effect from "effect/Effect";
import {
  CATALOG_STORE_NAME,
  catalogError,
  OBJECT_STORE_NAMES,
  openDatabaseAt,
  readDatabaseValue,
} from "./indexedDbStorage";

// Database used before the rebrand; its stores are copied forward once and the
// legacy database is retired only after the copy succeeds.
const LEGACY_DATABASE_NAME = "t3code:connection-runtime";

// Written with the copied records so a legacy database that survives a blocked
// deletion is never copied again over later removals.
const LEGACY_MIGRATED_KEY = "legacy-migrated";

/** Fill missing target records from `source` and record the migration inside one transaction. */
const copyDatabaseContents = Effect.fn("web.connectionStorage.copyDatabaseContents")(function* (
  source: IDBDatabase,
  target: IDBDatabase,
) {
  const storeNames = OBJECT_STORE_NAMES.filter(
    (storeName) =>
      source.objectStoreNames.contains(storeName) && target.objectStoreNames.contains(storeName),
  );

  const entries = yield* Effect.callback<
    ReadonlyArray<readonly [string, IDBValidKey, unknown]>,
    ConnectionTransientError
  >((resume) => {
    const collected: Array<readonly [string, IDBValidKey, unknown]> = [];

    if (storeNames.length === 0) {
      resume(Effect.succeed(collected));

      return;
    }

    const transaction = source.transaction(storeNames, "readonly");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("migrate", transaction.error ?? "Unknown IndexedDB read error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.succeed(collected));
    });

    for (const storeName of storeNames) {
      const request = transaction.objectStore(storeName).openCursor();
      request.addEventListener("success", () => {
        const cursor = request.result;

        if (cursor === null) return;
        collected.push([storeName, cursor.key, cursor.value] as const);
        cursor.continue();
      });
      request.addEventListener("error", () => {
        resume(
          Effect.fail(catalogError("migrate", request.error ?? "Unknown IndexedDB cursor error")),
        );
      });
    }
  });

  yield* Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = target.transaction([...storeNames, CATALOG_STORE_NAME], "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("migrate", transaction.error ?? "Unknown IndexedDB write error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });

    for (const [storeName, key, value] of entries) {
      const store = transaction.objectStore(storeName);
      const existing = store.getKey(key);
      existing.addEventListener("success", () => {
        if (existing.result === undefined) store.put(value, key);
      });
    }

    transaction.objectStore(CATALOG_STORE_NAME).put(true, LEGACY_MIGRATED_KEY);
  });
});

const deleteLegacyDatabase = Effect.fn("web.connectionStorage.deleteLegacyDatabase")(function* () {
  yield* Effect.callback<void, never>((resume) => {
    const request = indexedDB.deleteDatabase(LEGACY_DATABASE_NAME);
    request.addEventListener("success", () => resume(Effect.void));
    request.addEventListener("error", () => resume(Effect.void));
    request.addEventListener("blocked", () => resume(Effect.void));
  });
});

/** Fill missing Akeru records from the old database, then retire it only
 * after the copy commits. A failed migration leaves the source for retry. */
export const migrateLegacyConnectionDatabase = Effect.fn(
  "web.connectionStorage.migrateLegacyConnectionDatabase",
)(function* (database: IDBDatabase) {
  if (typeof indexedDB === "undefined") return;

  if ((yield* readDatabaseValue(database, CATALOG_STORE_NAME, LEGACY_MIGRATED_KEY)) === true)
    return;
  const legacyResult = yield* Effect.result(openDatabaseAt(LEGACY_DATABASE_NAME));

  if (hasTag(legacyResult, "Failure")) {
    yield* Effect.logWarning("Could not open the legacy connection database for migration.").pipe(
      Effect.annotateLogs({ error: legacyResult.failure }),
    );

    return;
  }

  yield* Effect.scoped(
    Effect.gen(function* () {
      const legacy = yield* Effect.acquireRelease(Effect.succeed(legacyResult.success), (db) =>
        Effect.sync(() => db.close()),
      );

      yield* copyDatabaseContents(legacy, database);
    }),
  );
  yield* deleteLegacyDatabase();
});
