// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { expect, it } from "vite-plus/test";

import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { hasActiveTurns, isLocalMachineCaller } from "./updateRoute.ts";

const machineRequest = (remoteAddress: string, headers: Record<string, string> = {}) =>
  HttpServerRequest.fromWeb(
    Object.assign(new Request("http://127.0.0.1/api/remote/update", { method: "POST", headers }), {
      remoteAddress,
    }),
  );

it("accepts the machine token only from direct loopback callers", () => {
  expect(isLocalMachineCaller(machineRequest("127.0.0.1"))).toBe(true);
  expect(isLocalMachineCaller(machineRequest("::ffff:127.0.0.1"))).toBe(true);
  expect(isLocalMachineCaller(machineRequest("::1"))).toBe(true);
  expect(isLocalMachineCaller(machineRequest("100.64.0.7"))).toBe(false);
  expect(
    isLocalMachineCaller(machineRequest("127.0.0.1", { "x-forwarded-for": "100.64.0.7" })),
  ).toBe(false);
});

it("defers unattended updates while any bot turn is active", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-update-route-"));
  const dbPath = NodePath.join(root, "state.sqlite");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE projection_thread_sessions (
    thread_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    active_turn_id TEXT
  )`);
  db.exec(`CREATE TABLE projection_turns (
    thread_id TEXT NOT NULL,
    turn_id TEXT,
    pending_message_id TEXT,
    state TEXT NOT NULL,
    requested_at TEXT NOT NULL
  )`);
  db.prepare("INSERT INTO projection_thread_sessions VALUES (?, ?, ?)").run(
    "thread-1",
    "idle",
    null,
  );
  expect(hasActiveTurns(dbPath, 0)).toBe(false);
  db.prepare("UPDATE projection_thread_sessions SET status = ?").run("starting");
  expect(hasActiveTurns(dbPath, 0)).toBe(true);
  db.prepare("UPDATE projection_thread_sessions SET status = ?, active_turn_id = ?").run(
    "running",
    "turn-1",
  );
  db.close();
  expect(hasActiveTurns(dbPath, 0)).toBe(true);
  NodeFS.rmSync(root, { recursive: true, force: true });
});

it("counts an admitted turn that has not reached its provider yet", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-update-route-"));
  const dbPath = NodePath.join(root, "state.sqlite");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec(`CREATE TABLE projection_thread_sessions (
    thread_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    active_turn_id TEXT
  )`);
  db.exec(`CREATE TABLE projection_turns (
    thread_id TEXT NOT NULL,
    turn_id TEXT,
    pending_message_id TEXT,
    state TEXT NOT NULL,
    requested_at TEXT NOT NULL
  )`);
  const now = Date.parse("2026-09-30T12:00:00.000Z");
  db.prepare("INSERT INTO projection_turns VALUES (?, ?, ?, ?, ?)").run(
    "thread-1",
    null,
    "message-1",
    "pending",
    "2026-09-30T11:59:58.000Z",
  );
  expect(hasActiveTurns(dbPath, now)).toBe(true);
  // A start abandoned long ago must not defer updates forever.
  db.prepare("UPDATE projection_turns SET requested_at = ?").run("2026-09-30T10:00:00.000Z");
  db.close();
  expect(hasActiveTurns(dbPath, now)).toBe(false);
  NodeFS.rmSync(root, { recursive: true, force: true });
});
