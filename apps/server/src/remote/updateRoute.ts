// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

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

export function hasActiveTurns(dbPath: string): boolean {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS count FROM projection_thread_sessions WHERE status IN ('starting', 'running') OR active_turn_id IS NOT NULL",
      )
      .get() as { count: number };
    return row.count > 0;
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
            if (yield* Effect.sync(() => hasActiveTurns(config.dbPath))) {
              return HttpServerResponse.jsonUnsafe(
                { error: "active_work", retryAfterSeconds: 3600 },
                { status: 409, headers: { "retry-after": "3600" } },
              );
            }
            return yield* updater.update({ targetVersion }).pipe(
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
