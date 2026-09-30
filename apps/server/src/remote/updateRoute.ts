// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import { tryBeginMaintenance, withMaintenance } from "./updateGate.ts";

function sameSecret(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
}

/** The machine token is a local credential: proxied or non-loopback callers never reach it. */
export function isLocalMachineCaller(request: HttpServerRequest.HttpServerRequest): boolean {
  if (request.headers["x-forwarded-for"] || request.headers["forwarded"]) return false;
  const address = deriveAuthClientMetadata({ request }).ipAddress;
  return address === "::1" || (address?.startsWith("127.") ?? false);
}

/** Admitted turns count from commit: a pending start has no session row until its provider reacts. */
const PENDING_TURN_START_WINDOW_MS = 5 * 60_000;

export function hasActiveTurns(dbPath: string, nowMs: number): boolean {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessions = db
      .prepare(
        "SELECT COUNT(*) AS count FROM projection_thread_sessions WHERE status IN ('starting', 'running') OR active_turn_id IS NOT NULL",
      )
      .get() as { count: number };
    if (sessions.count > 0) return true;
    const pending = db
      .prepare(
        "SELECT COUNT(*) AS count FROM projection_turns WHERE turn_id IS NULL AND state = 'pending' AND pending_message_id IS NOT NULL AND requested_at >= ?",
      )
      .get(DateTime.formatIso(DateTime.makeUnsafe(nowMs - PENDING_TURN_START_WINDOW_MS))) as {
      count: number;
    };
    return pending.count > 0;
  } finally {
    db.close();
  }
}

export const remoteMachineUpdateRouteLayer = Layer.unwrap(
  Effect.map(ServerSelfUpdate.ServerSelfUpdate, (updater) =>
    HttpRouter.add(
      "POST",
      "/api/remote/update",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (!isLocalMachineCaller(request)) {
          return HttpServerResponse.jsonUnsafe({ error: "forbidden" }, { status: 403 });
        }
        const config = yield* ServerConfig.ServerConfig;
        const tokenPath = `${config.stateDir}/remote-control-token`;
        const expected = yield* Effect.try(() =>
          NodeFS.readFileSync(tokenPath, "utf8").trim(),
        ).pipe(Effect.orElseSucceed(() => ""));
        const presented = request.headers["x-akeru-machine-token"] ?? "";
        if (!expected || !sameSecret(presented, expected)) {
          return HttpServerResponse.jsonUnsafe({ error: "unauthorized" }, { status: 401 });
        }
        const payload = yield* request.json.pipe(Effect.orElseSucceed(() => null));
        const targetVersion =
          typeof payload === "object" && payload !== null && "targetVersion" in payload
            ? String(payload.targetVersion)
            : "";
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(targetVersion)) {
          return HttpServerResponse.jsonUnsafe(
            { error: "invalid_target_version" },
            { status: 400 },
          );
        }
        if (!tryBeginMaintenance()) {
          return HttpServerResponse.jsonUnsafe(
            { error: "active_work", retryAfterSeconds: 3600 },
            { status: 409, headers: { "retry-after": "3600" } },
          );
        }
        return yield* withMaintenance(
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            if (yield* Effect.sync(() => hasActiveTurns(config.dbPath, nowMs))) {
              return HttpServerResponse.jsonUnsafe(
                { error: "active_work", retryAfterSeconds: 3600 },
                { status: 409, headers: { "retry-after": "3600" } },
              );
            }
            return yield* updater.update({ targetVersion, source: "remote-archive" }).pipe(
              Effect.map((result) => HttpServerResponse.jsonUnsafe(result, { status: 202 })),
              Effect.catchTag("ServerSelfUpdateError", (error) =>
                Effect.succeed(
                  HttpServerResponse.jsonUnsafe(
                    { error: "update_failed", reason: error.reason },
                    { status: 500 },
                  ),
                ),
              ),
            );
          }),
        );
      }),
    ),
  ),
);
