import { ConnectionTransientError } from "@akeru/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";

const DATABASE_NAME = "akeru:connection-runtime";

const DATABASE_VERSION = 5;

export const CATALOG_STORE_NAME = "catalog";

export const SHELL_STORE_NAME = "shell";

export const THREAD_STORE_NAME = "thread";

export const SERVER_CONFIG_STORE_NAME = "server-config";

// Retired with the branch picker; version 5 drops the store from older databases.
const RETIRED_VCS_REFS_STORE_NAME = "vcs-refs";

export function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

export const OBJECT_STORE_NAMES = [
  CATALOG_STORE_NAME,
  SHELL_STORE_NAME,
  THREAD_STORE_NAME,
  SERVER_CONFIG_STORE_NAME,
] as const;

export const openDatabaseAt = (name: string) =>
  Effect.callback<IDBDatabase, ConnectionTransientError>((resume) => {
    if (typeof indexedDB === "undefined") {
      resume(
        Effect.fail(catalogError("open", "IndexedDB is unavailable in this browser context.")),
      );

      return;
    }

    const request = indexedDB.open(name, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      for (const storeName of OBJECT_STORE_NAMES) {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      }

      if (request.result.objectStoreNames.contains(RETIRED_VCS_REFS_STORE_NAME)) {
        request.result.deleteObjectStore(RETIRED_VCS_REFS_STORE_NAME);
      }
    });
    request.addEventListener("error", () => {
      resume(Effect.fail(catalogError("open", request.error ?? "Unknown IndexedDB error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  });

export const openDatabase = Effect.fn("web.connectionStorage.openDatabase")(function* () {
  return yield* openDatabaseAt(DATABASE_NAME);
});

export function readDatabaseValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<unknown, ConnectionTransientError>((resume) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.addEventListener("error", () => {
      resume(Effect.fail(catalogError("read", request.error ?? "Unknown IndexedDB read error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  }).pipe(Effect.withSpan("web.connectionStorage.readDatabaseValue"));
}

export function writeDatabaseValue<Value>(
  database: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  value: Value,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("write", transaction.error ?? "Unknown IndexedDB write error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(storeName).put(value, key);
  }).pipe(Effect.withSpan("web.connectionStorage.writeDatabaseValue"));
}

export function removeDatabaseValue(database: IDBDatabase, storeName: string, key: IDBValidKey) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("remove", transaction.error ?? "Unknown IndexedDB remove error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    transaction.objectStore(storeName).delete(key);
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValue"));
}

export function removeDatabaseValuesInRange(
  database: IDBDatabase,
  storeName: string,
  range: IDBKeyRange,
) {
  return Effect.callback<void, ConnectionTransientError>((resume) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("remove", transaction.error ?? "Unknown IndexedDB cursor error")),
      );
    });
    transaction.addEventListener("complete", () => {
      resume(Effect.void);
    });
    const request = transaction.objectStore(storeName).openCursor(range);
    request.addEventListener("error", () => {
      resume(
        Effect.fail(catalogError("remove", request.error ?? "Unknown IndexedDB cursor error")),
      );
    });
    request.addEventListener("success", () => {
      const cursor = request.result;

      if (cursor === null) {
        return;
      }

      cursor.delete();
      cursor.continue();
    });
  }).pipe(Effect.withSpan("web.connectionStorage.removeDatabaseValuesInRange"));
}

export function threadCacheKey(environmentId: EnvironmentId, threadId: ThreadId) {
  return `${environmentId}:${threadId}`;
}
