/**
 * Rebuild an isolated dev database from a pruned snapshot of the real
 * ~/.akeru database, then run this checkout's migrations against it.
 *
 * `vp run migrate-dev-db` from a worktree:
 *   1. Nukes `<worktree>/.akeru/userdata/state.sqlite`.
 *   2. Snapshots the real db (read-only VACUUM INTO) and prunes it to the
 *      most recently updated projects and, per project, the most recent
 *      threads that have fully stopped. Working, settled, and monitored
 *      threads are skipped so the dev server never adopts live work.
 *      Auth sessions, pairing links, command receipts, and provider
 *      runtime rows are dropped — pair a fresh browser against dev.
 *   3. Runs migrations on the result. Because the clone carries the real
 *      `effect_sql_migrations` table, this proves a new migration applies
 *      on top of the real applied set, and the slot check below catches
 *      the silent failure where two branches claim the same
 *      `Migrations/NNN_` id (the second one's CREATE TABLE is skipped).
 *
 * The event log (`orchestration_events`) is pruned per stream while
 * `sqlite_sequence` and `projection_state` carry over untouched, so new
 * events keep appending after the old high-water mark and projection
 * cursors never rewind.
 */
// @effect-diagnostics nodeBuiltinImport:off - node:os resolves the shared T3 home guard.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import { PRODUCT_HOME_DIRNAME, resolveWorktreeT3Home } from "@akeru/shared/devHome";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Command, Flag } from "effect/unstable/cli";
import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";

import { type RunMigrateDevDbInput, type RunMigrateDevDbOptions, MigrateDevDbNotInWorktreeError, MigrateDevDbSourceMissingError, MigrateDevDbSharedHomeError, MigrateDevDbSourceIsDestinationError, MigrateDevDbPhaseError } from "./migrateDevDbTypes.ts";
import { ensureNotInUse } from "./migrateDevDbSafety.ts";
import { verifyMigrationSlots, pruneSnapshot } from "./migrateDevDbSnapshot.ts";

const removeDatabaseFiles = Effect.fn("removeDatabaseFiles")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const suffix of ["", "-wal", "-shm"]) {
    yield* fs.remove(`${databasePath}${suffix}`).pipe(Effect.orElseSucceed(() => undefined));
  }
});

export const runMigrateDevDb = Effect.fn("runMigrateDevDb")(function* (
  input: RunMigrateDevDbInput,
  options: RunMigrateDevDbOptions = {},
) {
  // SQLite treats a negative LIMIT as "no limit", which would clone
  // everything. The CLI flags validate this too; this covers direct callers.
  if (input.projects < 1 || input.threadsPerProject < 0) {
    return yield* Effect.die("projects must be >= 1 and threadsPerProject >= 0");
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const sharedHome = path.resolve(
    options.sharedHome ?? path.join(NodeOS.homedir(), PRODUCT_HOME_DIRNAME),
  );
  const sourcePath = path.resolve(
    input.source ?? path.join(sharedHome, "userdata", "state.sqlite"),
  );

  const baseDir =
    input.baseDir !== undefined
      ? path.resolve(input.baseDir)
      : yield* resolveWorktreeT3Home(process.cwd());
  if (baseDir === undefined) {
    return yield* new MigrateDevDbNotInWorktreeError();
  }
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "state.sqlite");
  const snapshotPath = `${databasePath}.migrate-dev-db-tmp`;

  if (!(yield* fs.exists(sourcePath))) {
    return yield* new MigrateDevDbSourceMissingError({ sourcePath });
  }
  const [canonicalBaseDir, canonicalSharedHome] = yield* Effect.all([
    fs.realPath(baseDir).pipe(Effect.orElseSucceed(() => baseDir)),
    fs.realPath(sharedHome).pipe(Effect.orElseSucceed(() => sharedHome)),
  ]);
  if (canonicalBaseDir === canonicalSharedHome) {
    return yield* new MigrateDevDbSharedHomeError();
  }
  // The destination db and snapshot both get deleted below; a --source that
  // resolves to either (e.g. a leftover snapshot file) would be destroyed
  // before it is ever read.
  const canonicalSourcePath = yield* fs
    .realPath(sourcePath)
    .pipe(Effect.orElseSucceed(() => sourcePath));
  for (const destination of [databasePath, snapshotPath]) {
    const canonicalDestination = yield* fs
      .realPath(destination)
      .pipe(Effect.orElseSucceed(() => destination));
    if (canonicalSourcePath === canonicalDestination) {
      return yield* new MigrateDevDbSourceIsDestinationError({ sourcePath });
    }
  }

  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* ensureNotInUse(databasePath);

  const wrapPhase =
    (phase: MigrateDevDbPhaseError["phase"], phaseDatabasePath: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new MigrateDevDbPhaseError({ phase, databasePath: phaseDatabasePath, cause }),
        ),
      );

  yield* removeDatabaseFiles(snapshotPath);
  // The snapshot is a full-size copy of the source; make sure it is removed
  // even when a phase fails partway through.
  const { executedMigrations, pruned } = yield* Effect.gen(function* () {
    yield* Console.log(`Snapshotting ${sourcePath} (read-only)...`);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${snapshotPath}`;
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: sourcePath, readonly: true })),
      wrapPhase("snapshot", sourcePath),
    );

    // Migrate before pruning: a source older than this checkout would
    // otherwise crash the prune queries on columns that don't exist yet.
    // Running against the full snapshot also exercises new migrations on the
    // same data volume the real database would face.
    yield* Console.log("Running migrations on the snapshot...");
    const executed = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Mirror server boot (persistence/Layers/Sqlite.ts).
      yield* sql.unsafe("PRAGMA foreign_keys = ON").unprepared;
      return yield* runMigrations();
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("migrate", snapshotPath),
    );

    // Verify while the snapshot is still the only thing touched: a slot
    // collision must abort before the old worktree db gets replaced with a
    // schema whose colliding migration was silently skipped.
    yield* verifyMigrationSlots().pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(
            new MigrateDevDbPhaseError({ phase: "verify", databasePath: snapshotPath, cause }),
          ),
      }),
    );

    yield* Console.log(
      `Pruning to ${input.projects} projects, ${input.threadsPerProject} stopped threads each...`,
    );
    const result = yield* pruneSnapshot(input).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("prune", snapshotPath),
    );

    yield* Console.log(`Compacting into ${databasePath}...`);
    // Re-check right before the swap: a dev server started while the
    // snapshot was migrating and pruning must not lose its database.
    yield* ensureNotInUse(databasePath);
    yield* removeDatabaseFiles(databasePath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${databasePath}`;
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("compact", databasePath),
    );
    return { executedMigrations: executed, pruned: result };
  }).pipe(Effect.ensuring(removeDatabaseFiles(snapshotPath)));
  yield* fs.chmod(databasePath, 0o600);

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // WAL does not survive VACUUM INTO; set it so first `vp run dev` finds
    // the database exactly as server boot would have left it.
    yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    wrapPhase("compact", databasePath),
  );

  const size = (yield* fs.stat(databasePath)).size;
  return {
    databasePath,
    sizeBytes: Number(size),
    projects: pruned.projects,
    eventCount: pruned.eventCount,
    executedMigrations: executedMigrations.map(([id, name]) => `${id}_${name}`),
  };
});

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;

export const migrateDevDbCommand = Command.make(
  "migrate-dev-db",
  {
    projects: Flag.integer("projects").pipe(
      Flag.withDefault(5),
      Flag.withDescription("How many recently updated projects to keep."),
    ),
    threadsPerProject: Flag.integer("threads-per-project").pipe(
      Flag.withDefault(10),
      Flag.withDescription("How many recent stopped threads to keep per project."),
    ),
    baseDir: Flag.string("base-dir").pipe(
      Flag.optional,
      Flag.withDescription("Isolated .akeru directory. Defaults to the current worktree's .akeru."),
    ),
    source: Flag.string("source").pipe(
      Flag.optional,
      Flag.withDescription("Source database. Defaults to ~/.akeru/userdata/state.sqlite."),
    ),
  },
  ({ projects, threadsPerProject, baseDir, source }) =>
    Effect.gen(function* () {
      const result = yield* runMigrateDevDb({
        projects,
        threadsPerProject,
        baseDir: Option.getOrUndefined(baseDir),
        source: Option.getOrUndefined(source),
      });
      yield* Console.log("");
      yield* Console.log(
        `Dev database ready: ${result.databasePath} (${formatSize(result.sizeBytes)})`,
      );
      for (const project of result.projects) {
        yield* Console.log(`  ${project.title}: ${project.threads} threads`);
      }
      yield* Console.log(`  ${result.eventCount} orchestration events kept`);
      yield* Console.log(
        result.executedMigrations.length === 0
          ? "  Migrations: already current (no new migrations in this checkout)"
          : `  Migrations applied: ${result.executedMigrations.join(", ")}`,
      );
    }),
).pipe(
  Command.withDescription(
    "Rebuild the worktree dev database from a pruned snapshot of the real ~/.akeru data, then run migrations.",
  ),
);

if (import.meta.main) {
  Command.run(migrateDevDbCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}

export { MigrateDevDbNotInWorktreeError, MigrateDevDbSharedHomeError, MigrateDevDbSourceMissingError, MigrateDevDbSourceIsDestinationError, MigrateDevDbPhaseError, type RunMigrateDevDbInput, type RunMigrateDevDbOptions } from "./migrateDevDbTypes.ts";
export { MigrateDevDbServerRunningError, MigrateDevDbDestinationBusyError, ensureNotInUse } from "./migrateDevDbSafety.ts";
export { MigrateDevDbSlotCollisionError } from "./migrateDevDbSnapshot.ts";
