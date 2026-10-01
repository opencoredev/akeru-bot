import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";



export class MigrateDevDbServerRunningError extends Schema.TaggedErrorClass<MigrateDevDbServerRunningError>()(
  "MigrateDevDbServerRunningError",
  {
    databasePath: Schema.String,
    pid: Schema.Number,
  },
) {
  override get message(): string {
    return `Dev database at '${this.databasePath}' is open by a running server (pid ${this.pid} per server-runtime.json). Stop that server first; if that pid is not an Akeru Bot server (stale descriptor, reused pid), delete the server-runtime.json next to the database and retry.`;
  }
}

export class MigrateDevDbDestinationBusyError extends Schema.TaggedErrorClass<MigrateDevDbDestinationBusyError>()(
  "MigrateDevDbDestinationBusyError",
  {
    databasePath: Schema.String,
    reason: Schema.Literals(["write-locked", "wal-held"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail =
      this.reason === "write-locked"
        ? "the database is write-locked"
        : "another connection is holding its WAL";
    return `Dev database at '${this.databasePath}' looks in use (${detail}). Stop the dev server first; if none is running, delete the -wal/-shm files next to it.`;
  }
}

/** The slice of server-runtime.json this script cares about. */
export const ServerRuntimeState = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number }));

export const decodeServerRuntimeState = Schema.decodeEffect(ServerRuntimeState);

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** Liveness probe for a running dev server. The server writes its pid to
 * server-runtime.json next to the database, which also catches an idle
 * server holding an open-but-inactive connection. The SQL probes below back
 * that up: BEGIN IMMEDIATE fails while a writer is active, and
 * wal_checkpoint(TRUNCATE) reports busy while another connection holds the
 * WAL. A leftover -shm alone is not a signal — read-only connections cannot
 * clean it up on close. */
export const ensureNotInUse = Effect.fn("ensureDevDbNotInUse")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runtimeStatePath = path.join(path.dirname(databasePath), "server-runtime.json");
  const runtimeState = yield* fs.readFileString(runtimeStatePath).pipe(
    Effect.flatMap(decodeServerRuntimeState),
    // A missing or malformed descriptor is not a liveness signal.
    Effect.option,
  );
  if (Option.isSome(runtimeState) && isProcessAlive(runtimeState.value.pid)) {
    return yield* new MigrateDevDbServerRunningError({
      databasePath,
      pid: runtimeState.value.pid,
    });
  }

  if (!(yield* fs.exists(databasePath))) {
    return;
  }
  const checkpoint = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 0").unprepared;
    yield* sql.unsafe("BEGIN IMMEDIATE").unprepared;
    yield* sql.unsafe("ROLLBACK").unprepared;
    return yield* sql.unsafe<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    Effect.mapError(
      (cause) =>
        new MigrateDevDbDestinationBusyError({
          databasePath,
          reason: "write-locked",
          cause,
        }),
    ),
  );
  if (checkpoint[0] !== undefined && Number(checkpoint[0].busy) !== 0) {
    return yield* new MigrateDevDbDestinationBusyError({
      databasePath,
      reason: "wal-held",
    });
  }
});
