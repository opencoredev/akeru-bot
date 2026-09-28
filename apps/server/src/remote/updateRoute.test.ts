// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { expect, it } from "vite-plus/test";

import { hasActiveTurns } from "./updateRoute.ts";

it("defers unattended updates while any bot turn is active", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-update-route-"));
  const dbPath = NodePath.join(root, "state.sqlite");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE projection_thread_sessions (
    thread_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    active_turn_id TEXT
  )`);
  db.prepare("INSERT INTO projection_thread_sessions VALUES (?, ?, ?)").run(
    "thread-1",
    "idle",
    null,
  );
  expect(hasActiveTurns(dbPath)).toBe(false);
  db.prepare("UPDATE projection_thread_sessions SET status = ?, active_turn_id = ?").run(
    "running",
    "turn-1",
  );
  db.close();
  expect(hasActiveTurns(dbPath)).toBe(true);
  NodeFS.rmSync(root, { recursive: true, force: true });
});
