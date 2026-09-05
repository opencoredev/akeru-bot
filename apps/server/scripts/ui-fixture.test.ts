import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../src/orchestration/ThreadPlanProgress.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";

import * as NodeSqliteClient from "../src/persistence/NodeSqliteClient.ts";
import { runSqliteState } from "./t3-sqlite-state.ts";
import { runUiFixture, UI_FIXTURE_CASES } from "./ui-fixture.ts";

const encodeRuntimePid = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int })),
);

it.layer(NodeServices.layer)("ui-fixture", (it) => {
  it.effect(
    "migrates offline and repeats each bounded projection case without events or credentials",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-ui-fixture-" });
        for (const scenario of UI_FIXTURE_CASES) {
          const first = yield* runUiFixture({ baseDir, scenario });
          const before = yield* runSqliteState({
            operation: "query",
            baseDir,
            sql: "SELECT * FROM projection_threads ORDER BY thread_id",
          });
          const second = yield* runUiFixture({ baseDir, scenario });
          yield* Effect.gen(function* () {
            const query = yield* ProjectionSnapshotQuery;
            const snapshot = yield* query.getSnapshot();
            assert.equal(
              snapshot.threads.length,
              scenario === "empty" ? 0 : scenario === "edge" ? 3 : 2,
            );
            for (const thread of snapshot.threads.filter((thread) => thread.messages.length > 0)) {
              assert.deepStrictEqual(
                thread.messages.map((message) => message.role),
                ["user", "assistant"],
              );
            }
          }).pipe(
            Effect.provide(
              OrchestrationProjectionSnapshotQueryLive.pipe(
                Layer.provide(ThreadBackgroundLiveness.layer),
                Layer.provide(ThreadPlanProgress.layer),
                Layer.provide(RepositoryIdentityResolver.layer),
                Layer.provide(NodeSqliteClient.layer({ filename: second.database })),
              ),
            ),
          );
          assert.equal(second.kind, "projection-only");
          assert.ok(second.backup);
          assert.notEqual(first.backup, second.backup);
          assert.equal((yield* fs.stat(second.backup!)).mode & 0o777, 0o600);
          const after = yield* runSqliteState({
            operation: "query",
            baseDir,
            sql: "SELECT * FROM projection_threads ORDER BY thread_id",
          });
          assert.deepStrictEqual(before, after);
          if (after.operation === "query") {
            assert.equal(after.rows.length, scenario === "empty" ? 0 : scenario === "edge" ? 3 : 2);
          }
          const counts = yield* runSqliteState({
            operation: "query",
            baseDir,
            sql: `SELECT
          (SELECT COUNT(*) FROM orchestration_events) AS events,
          (SELECT COUNT(*) FROM auth_sessions) AS sessions,
          (SELECT COUNT(*) FROM auth_pairing_links) AS links,
          (SELECT COUNT(*) FROM provider_session_runtime) AS providers,
          (SELECT COUNT(*) FROM projection_thread_messages) AS messages`,
          });
          if (counts.operation === "query")
            assert.deepStrictEqual(counts.rows, [
              {
                events: 0,
                sessions: 0,
                links: 0,
                providers: 0,
                messages: scenario === "empty" ? 0 : 4,
              },
            ]);
        }
      }),
  );

  it.effect("retries a fresh directory that only contains the ownership marker", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-ui-retry-" });
      // A failed fresh run leaves the marker without userdata; a retry must succeed.
      yield* fs.writeFileString(
        path.join(baseDir, ".ui-fixture"),
        "akeru-ui-projection-fixture-v1\n",
      );
      const result = yield* runUiFixture({ baseDir, scenario: "populated" });
      assert.equal(result.kind, "projection-only");
      assert.equal(result.backup, null);
    }),
  );

  it.effect("repairs a partially migrated database from an interrupted run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-ui-partial-" });
      // A run that died mid-migration leaves the marker and an incomplete database.
      yield* fs.writeFileString(
        path.join(baseDir, ".ui-fixture"),
        "akeru-ui-projection-fixture-v1\n",
      );
      yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
      yield* fs.writeFileString(path.join(baseDir, "userdata", "state.sqlite"), "");
      const result = yield* runUiFixture({ baseDir, scenario: "populated" });
      assert.equal(result.kind, "projection-only");
      assert.ok(result.backup);
    }),
  );

  it.effect("refuses shared descendants, aliases, and unowned directories before writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-ui-guard-" });
      const shared = path.join(parent, "shared");
      const nested = path.join(shared, "dev");
      yield* fs.makeDirectory(nested, { recursive: true });
      const alias = path.join(parent, "alias");
      yield* fs.symlink(nested, alias);
      for (const baseDir of [shared, nested, alias]) {
        const error = yield* runUiFixture(
          { baseDir, scenario: "empty" },
          { sharedHome: shared },
        ).pipe(Effect.flip);
        assert.equal(error._tag, "SqliteStateSharedHomeMutationError");
      }
      assert.deepStrictEqual(yield* fs.readDirectory(nested), []);
      yield* fs.writeFileString(path.join(nested, "keep"), "not fixture data");
      const error = yield* runUiFixture({ baseDir: nested, scenario: "empty" }).pipe(Effect.flip);
      assert.equal(error._tag, "UiFixtureSafetyError");
      assert.deepStrictEqual(yield* fs.readDirectory(nested), ["keep"]);
    }),
  );

  it.effect("refuses a running server descriptor and redirected databases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-ui-running-" });
      const fixture = yield* runUiFixture({ baseDir, scenario: "populated" });
      const descriptor = path.join(baseDir, "userdata", "server-runtime.json");
      yield* fs.writeFileString(descriptor, yield* encodeRuntimePid({ pid: process.pid }));
      const before = yield* fs.readDirectory(path.dirname(fixture.database));
      const running = yield* runUiFixture({ baseDir, scenario: "empty" }).pipe(Effect.flip);
      assert.equal(running._tag, "MigrateDevDbServerRunningError");
      assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(fixture.database)), before);
      yield* fs.remove(descriptor);
      const target = path.join(baseDir, "saved.sqlite");
      yield* fs.rename(fixture.database, target);
      yield* fs.symlink(target, fixture.database);
      const redirected = yield* runUiFixture({ baseDir, scenario: "empty" }).pipe(Effect.flip);
      assert.equal(redirected._tag, "UiFixtureSafetyError");
    }),
  );

  it.effect(
    "refuses credential-bearing fixture databases before backup or projection changes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-ui-credentials-" });
        const fixture = yield* runUiFixture({ baseDir, scenario: "populated" });
        yield* runSqliteState({
          operation: "exec",
          baseDir,
          sql: `INSERT INTO auth_pairing_links
        (id, credential, method, scopes, subject, created_at, expires_at)
        VALUES ('synthetic', 'not-a-real-credential', 'pairing', '[]', 'test', '2026-01-01', '2026-01-02')`,
        });
        const before = yield* fs.readDirectory(path.dirname(fixture.database));
        const error = yield* runUiFixture({ baseDir, scenario: "empty" }).pipe(Effect.flip);
        assert.equal(error._tag, "UiFixtureSafetyError");
        assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(fixture.database)), before);
        const result = yield* runSqliteState({
          operation: "query",
          baseDir,
          sql: "SELECT COUNT(*) AS count FROM projection_threads",
        });
        if (result.operation === "query") assert.deepStrictEqual(result.rows, [{ count: 2 }]);
      }),
  );

  it.effect("refuses an active SQLite writer without a server descriptor", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-ui-locked-" });
      const fixture = yield* runUiFixture({ baseDir, scenario: "populated" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe("BEGIN IMMEDIATE").unprepared;
        const error = yield* runUiFixture({ baseDir, scenario: "empty" }).pipe(Effect.flip);
        assert.equal(error._tag, "MigrateDevDbDestinationBusyError");
        yield* sql.unsafe("ROLLBACK").unprepared;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: fixture.database })));
    }),
  );
});
