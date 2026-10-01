import {
  ConnectionPersistenceError,
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EnvironmentCacheStore,
  registerConnectionInCatalog,
  removeCatalogValue,
  removeConnectionFromCatalog,
  replaceCatalogValue,
} from "@akeru/client-runtime/platform";
import { CredentialStore, ProfileStore } from "@akeru/client-runtime/connection";
import {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ServerConfig,
  ThreadId,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  SHELL_STORE_NAME,
  THREAD_STORE_NAME,
  SERVER_CONFIG_STORE_NAME,
  openDatabase,
  readDatabaseValue,
  writeDatabaseValue,
  removeDatabaseValue,
  removeDatabaseValuesInRange,
  threadCacheKey,
} from "./indexedDbStorage";
import { migrateLegacyConnectionDatabase } from "./legacyDatabaseMigration";
import { makeCatalogBackend, makeCatalogStore } from "./catalogStorage";

const SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION = 1;

const StoredShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationShellSnapshot,
});

const StoredShellSnapshotJson = Schema.fromJsonString(StoredShellSnapshot);

// v2 stores the snapshot sequence alongside the thread so a warm cache can
// resume via `afterSequence` instead of re-downloading the full thread body.
// v3 adds windowed (paginated) snapshots carrying `page` metadata. The bump
// exists for rollback safety: a pre-pagination client would decode a windowed
// v2 record, silently drop the unknown `page` field, and treat the partial
// thread as complete forever. Older entries fail to decode → cold cache.
const StoredThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: OrchestrationThreadDetailSnapshot,
});

const StoredThreadSnapshotJson = Schema.fromJsonString(StoredThreadSnapshot);

const StoredServerConfig = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  environmentId: EnvironmentId,
  config: ServerConfig,
});

const StoredServerConfigJson = Schema.fromJsonString(StoredServerConfig);

const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(StoredShellSnapshotJson);

const encodeStoredShellSnapshot = Schema.encodeEffect(StoredShellSnapshotJson);

const decodeStoredThreadSnapshot = Schema.decodeUnknownEffect(StoredThreadSnapshotJson);

const encodeStoredThreadSnapshot = Schema.encodeEffect(StoredThreadSnapshotJson);

const decodeStoredServerConfig = Schema.decodeUnknownEffect(StoredServerConfigJson);

const encodeStoredServerConfig = Schema.encodeEffect(StoredServerConfigJson);

function persistenceError(
  operation:
    | "list-targets"
    | "register-connection"
    | "remove-connection"
    | "load-shell"
    | "save-shell"
    | "load-thread"
    | "save-thread"
    | "remove-thread"
    | "load-server-config"
    | "save-server-config"
    | "clear-environment",
  cause: unknown,
) {
  return new ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

export const connectionStorageLayer = Layer.effectContext(
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(openDatabase(), (database) =>
      Effect.sync(() => database.close()),
    );

    yield* migrateLegacyConnectionDatabase(database).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Connection database migration failed; using the new database.", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
    const catalog = yield* makeCatalogStore(makeCatalogBackend(database));

    const targetStore = ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => document.targets),
        Effect.mapError((cause) => persistenceError("list-targets", cause)),
      ),
    });

    const registrationStore = ConnectionRegistrationStore.of({
      register: (registration) =>
        catalog
          .update((document) => registerConnectionInCatalog(document, registration))
          .pipe(Effect.mapError((cause) => persistenceError("register-connection", cause))),
      remove: (target) =>
        catalog
          .update((document) => removeConnectionFromCatalog(document, target))
          .pipe(Effect.mapError((cause) => persistenceError("remove-connection", cause))),
    });

    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.profiles.find((profile) => profile.connectionId === connectionId),
            ),
          ),
        ),
      put: (profile) =>
        catalog.update((document) => ({
          ...document,
          profiles: replaceCatalogValue(document.profiles, (value) => value.connectionId, profile),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          profiles: removeCatalogValue(
            document.profiles,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });

    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        catalog.read.pipe(
          Effect.map((document) =>
            Option.fromUndefinedOr(
              document.credentials.find((entry) => entry.connectionId === connectionId)?.credential,
            ),
          ),
        ),
      put: (connectionId, credential) =>
        catalog.update((document) => ({
          ...document,
          credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
            connectionId,
            credential,
          }),
        })),
      remove: (connectionId) =>
        catalog.update((document) => ({
          ...document,
          credentials: removeCatalogValue(
            document.credentials,
            (value) => value.connectionId,
            connectionId,
          ),
        })),
    });

    const cacheStore = EnvironmentCacheStore.of({
      loadShell: (environmentId) =>
        readDatabaseValue(database, SHELL_STORE_NAME, environmentId).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeed(Option.none());
            }

            return decodeStoredShellSnapshot(raw).pipe(
              Effect.mapError((cause) => persistenceError("load-shell", cause)),
              Effect.map((stored) =>
                stored.environmentId === environmentId
                  ? Option.some(stored.snapshot)
                  : Option.none(),
              ),
            );
          }),
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("load-shell", cause),
          ),
        ),
      saveShell: (environmentId, snapshot) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredShellSnapshot({
            schemaVersion: SHELL_SNAPSHOT_CACHE_SCHEMA_VERSION,
            environmentId,
            snapshot,
          }).pipe(Effect.mapError((cause) => persistenceError("save-shell", cause)));

          yield* writeDatabaseValue(database, SHELL_STORE_NAME, environmentId, encoded);
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-shell", cause),
          ),
        ),
      loadServerConfig: (environmentId) =>
        readDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeed(Option.none());
            }

            return decodeStoredServerConfig(raw).pipe(
              Effect.mapError((cause) => persistenceError("load-server-config", cause)),
              Effect.map((stored) =>
                stored.environmentId === environmentId ? Option.some(stored.config) : Option.none(),
              ),
            );
          }),
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("load-server-config", cause),
          ),
        ),
      saveServerConfig: (environmentId, config) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredServerConfig({
            schemaVersion: 1,
            environmentId,
            config,
          }).pipe(Effect.mapError((cause) => persistenceError("save-server-config", cause)));

          yield* writeDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId, encoded);
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-server-config", cause),
          ),
        ),
      loadThread: (environmentId, threadId) =>
        readDatabaseValue(
          database,
          THREAD_STORE_NAME,
          threadCacheKey(environmentId, threadId),
        ).pipe(
          Effect.flatMap((raw) => {
            if (typeof raw !== "string") {
              return Effect.succeed(Option.none());
            }

            return decodeStoredThreadSnapshot(raw).pipe(
              Effect.mapError((cause) => persistenceError("load-thread", cause)),
              Effect.map((stored) =>
                stored.environmentId === environmentId && stored.threadId === threadId
                  ? Option.some(stored.snapshot)
                  : Option.none(),
              ),
            );
          }),
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("load-thread", cause),
          ),
        ),
      saveThread: (environmentId, snapshot) =>
        Effect.gen(function* () {
          const encoded = yield* encodeStoredThreadSnapshot({
            schemaVersion: 3,
            environmentId,
            threadId: snapshot.thread.id,
            snapshot,
          }).pipe(Effect.mapError((cause) => persistenceError("save-thread", cause)));

          yield* writeDatabaseValue(
            database,
            THREAD_STORE_NAME,
            threadCacheKey(environmentId, snapshot.thread.id),
            encoded,
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ConnectionPersistenceError"
              ? cause
              : persistenceError("save-thread", cause),
          ),
        ),
      removeThread: (environmentId, threadId) =>
        removeDatabaseValue(
          database,
          THREAD_STORE_NAME,
          threadCacheKey(environmentId, threadId),
        ).pipe(Effect.mapError((cause) => persistenceError("remove-thread", cause))),
      clear: (environmentId) =>
        Effect.all(
          [
            removeDatabaseValue(database, SHELL_STORE_NAME, environmentId),
            removeDatabaseValuesInRange(
              database,
              THREAD_STORE_NAME,
              IDBKeyRange.bound(`${environmentId}:`, `${environmentId}:\uffff`),
            ),
            removeDatabaseValue(database, SERVER_CONFIG_STORE_NAME, environmentId),
          ],
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.mapError((cause) => persistenceError("clear-environment", cause))),
    });

    return Context.make(ConnectionTargetStore, targetStore).pipe(
      Context.add(ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(EnvironmentCacheStore, cacheStore),
    );
  }),
);

export { migrateLegacyConnectionDatabase } from "./legacyDatabaseMigration";

export { type CatalogBackend, makeCatalogBackend, makeCatalogStore } from "./catalogStorage";
