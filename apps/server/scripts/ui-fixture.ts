#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Command, Flag } from "effect/unstable/cli";

import { SHOWCASE_THREADS } from "../../../scripts/mobile-showcase-environment.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { ensureNotInUse } from "./migrate-dev-db.ts";
import { backupSqliteState, guardSqliteStateHome } from "./t3-sqlite-state.ts";

export const UI_FIXTURE_CASES = ["empty", "populated", "edge"] as const;
const decodeFixtureCase = Schema.decodeUnknownEffect(Schema.Literals(UI_FIXTURE_CASES));
const MARKER = "akeru-ui-projection-fixture-v1\n";
const TIMESTAMP = "2026-01-15T12:00:00.000Z";
const COMPLETED_AT = "2026-01-15T12:01:00.000Z";

export class UiFixtureSafetyError extends Schema.TaggedErrorClass<UiFixtureSafetyError>()(
  "UiFixtureSafetyError",
  { message: Schema.String },
) {}

// Projection-only display data. No events, credentials, provider sessions, or work are created.
const seedProjections = Effect.fn("seedUiProjections")(function* (
  scenario: (typeof UI_FIXTURE_CASES)[number],
  workspaceRoot: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'projection_%'`;
  for (const { name } of tables) {
    yield* sql.unsafe(`DELETE FROM "${name.replaceAll('"', '""')}"`).unprepared;
  }
  yield* sql`DELETE FROM sqlite_sequence WHERE name = 'projection_turns'`;
  if (scenario === "empty") return;
  const model = '{"instanceId":"codex","model":"gpt-5.4"}';
  yield* sql`INSERT INTO projection_bots
    (bot_id, name, title, avatar_json, created_at, updated_at)
    VALUES ('ui-scout', 'Scout', 'Code review', '{"kind":"dither","seed":"scout"}', ${TIMESTAMP}, ${TIMESTAMP})`;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at)
    VALUES ('ui-project', 'Akeru Bot', ${workspaceRoot}, ${model}, '[]', ${TIMESTAMP}, ${TIMESTAMP})`;
  for (const [index, thread] of SHOWCASE_THREADS.slice(0, 2).entries()) {
    const id = `ui-thread-${index}`;
    const turn = `${id}-turn`;
    const title =
      scenario === "edge" && index === 1
        ? "Review a long chat title with Unicode — 日本語 — and narrow mobile layouts without losing the selected chat"
        : thread.title;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, bot_id, title, model_selection_json, runtime_mode, interaction_mode,
       latest_turn_id, latest_user_message_at, created_at, updated_at, pinned_at, archived_at)
      VALUES (${id}, 'ui-project', 'ui-scout', ${title}, ${model}, 'approval-required', 'default',
       ${turn}, ${TIMESTAMP}, ${TIMESTAMP}, ${TIMESTAMP}, ${index === 0 ? TIMESTAMP : null},
       ${scenario === "edge" && index === 1 ? TIMESTAMP : null})`;
    for (const [role, text] of [
      ["user", thread.request],
      ["assistant", thread.response],
    ] as const) {
      const createdAt = role === "user" ? TIMESTAMP : COMPLETED_AT;
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`${id}-${role}`}, ${id}, ${turn}, ${role}, ${text}, 0, ${createdAt}, ${createdAt})`;
    }
    yield* sql`INSERT INTO projection_turns
      (thread_id, turn_id, assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
      VALUES (${id}, ${turn}, ${`${id}-assistant`}, 'completed', ${TIMESTAMP}, ${TIMESTAMP}, ${COMPLETED_AT}, '[]')`;
  }
  if (scenario === "edge") {
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('ui-empty-project', 'Empty project', ${workspaceRoot}, '[]', ${TIMESTAMP}, ${TIMESTAMP})`;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, bot_id, title, model_selection_json, created_at, updated_at)
      VALUES ('ui-empty-thread', 'ui-project', 'ui-scout', 'Empty chat', ${model}, ${TIMESTAMP}, ${TIMESTAMP})`;
  }
});

export const runUiFixture = Effect.fn("runUiFixture")(function* (
  input: { readonly baseDir: string; readonly scenario: (typeof UI_FIXTURE_CASES)[number] },
  options: { readonly sharedHome?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scenario = yield* decodeFixtureCase(input.scenario);
  const baseDir = yield* fs.realPath(path.resolve(input.baseDir));
  yield* guardSqliteStateHome(baseDir, options.sharedHome);
  const markerPath = path.join(baseDir, ".ui-fixture");
  const entries = yield* fs.readDirectory(baseDir);
  const fresh = entries.length === 0;
  if (
    !fresh &&
    (yield* fs.readFileString(markerPath).pipe(Effect.orElseSucceed(() => ""))) !== MARKER
  ) {
    return yield* new UiFixtureSafetyError({
      message: "Use an empty isolated directory or a directory created by ui-fixture.",
    });
  }
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "state.sqlite");
  // A marker without a database is a failed fresh run; migrate it like a fresh one.
  const databaseExists = yield* fs.exists(databasePath);
  // Reject redirected state and hard links before any SQLite connection opens.
  for (const target of [
    markerPath,
    stateDir,
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    path.join(baseDir, "workspace"),
  ]) {
    if (Option.isSome(yield* fs.readLink(target).pipe(Effect.option))) {
      return yield* new UiFixtureSafetyError({
        message: "Fixture state must not use symbolic links or hard links.",
      });
    }
    if (yield* fs.exists(target)) {
      const canonical = yield* fs.realPath(target);
      const stat = yield* fs.stat(target);
      if (
        canonical !== target ||
        (stat.type === "File" && Option.getOrElse(stat.nlink, () => 1) !== 1)
      ) {
        return yield* new UiFixtureSafetyError({
          message: "Fixture state must not use symbolic links or hard links.",
        });
      }
    }
  }
  yield* ensureNotInUse(databasePath);
  // Mark ownership before creating state so a failed fresh run stays retryable.
  if (fresh) yield* fs.writeFileString(markerPath, MARKER);
  yield* fs.makeDirectory(stateDir, { recursive: true });
  const result = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Refuse protected state before migrations or backups touch the database.
    // A table missing from a partially migrated database counts as empty.
    for (const table of [
      "orchestration_events",
      "auth_sessions",
      "auth_pairing_links",
      "provider_session_runtime",
    ]) {
      const present = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
        FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
      if (Number(present[0]?.count) === 0) continue;
      const rows = yield* sql.unsafe<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
        .unprepared;
      if (Number(rows[0]?.count) !== 0) {
        return yield* new UiFixtureSafetyError({
          message:
            "Fixture database contains events, credentials, or provider state. Use a new empty directory.",
        });
      }
    }
    // Migrating also repairs a database left behind by an interrupted run.
    yield* runMigrations();
    const backup = databaseExists ? yield* backupSqliteState(databasePath) : null;
    yield* sql.withTransaction(seedProjections(scenario, path.join(baseDir, "workspace")));
    return { database: databasePath, backup, scenario, kind: "projection-only" };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
  yield* fs.makeDirectory(path.join(baseDir, "workspace"), { recursive: true });
  yield* fs.writeFileString(markerPath, MARKER);
  return result;
});

export const uiFixtureCommand = Command.make(
  "ui-fixture",
  {
    baseDir: Flag.string("base-dir").pipe(
      Flag.withDescription(
        "Existing empty isolated directory, or a previous UI fixture directory. Stop its server first.",
      ),
    ),
    scenario: Flag.choice("case", UI_FIXTURE_CASES).pipe(Flag.withDefault("populated")),
  },
  (input) =>
    runUiFixture(input).pipe(
      Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
    ),
).pipe(
  Command.withDescription(
    "Seed deterministic projection-only UI data offline. Not an event-sourced business test.",
  ),
);

if (import.meta.main) {
  Command.run(uiFixtureCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
