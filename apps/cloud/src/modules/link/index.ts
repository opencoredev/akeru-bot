import {
  CLOUD_LINK_POLL_PATH,
  CLOUD_LINK_START_PATH,
  CloudEnvironmentId,
  CloudLinkPollRequest,
  CloudLinkStartRequest,
  type CloudLinkPollResponse,
  type CloudLinkStartResponse,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";

import { requireUser } from "../../auth.ts";
import type { CloudHono } from "../../deps.ts";
import { createUserCode, normalizeUserCode, randomToken, sha256Hex } from "../../lib/crypto.ts";
import { decodeJsonBody } from "../../lib/schema.ts";

export const LINK_CODE_TTL_MS = 10 * 60_000;

export const LINK_POLL_INTERVAL_SECONDS = 3;

export const MAX_OUTSTANDING_LINK_CODES = 1000;

const UserCodeBody = Schema.Struct({ userCode: Schema.String.check(Schema.isMaxLength(32)) });

interface LinkCodeRow {
  readonly user_code: string;
  readonly environment_name: string;
  readonly server_version: string;
  readonly expires_at: string;
  readonly approved_user_id: string | null;
  readonly denied: number;
}

const invalid = { error: "invalid-request" } as const;

/**
 * Device link. The environment starts a flow and polls with its device code;
 * the user approves the short user code in the browser. Only hashes of the
 * device code and the resulting environment token are stored.
 */
export function registerLink(app: CloudHono) {
  app.post(CLOUD_LINK_START_PATH, async (c) => {
    const body = await decodeJsonBody(c.req.raw, CloudLinkStartRequest);

    if (!body) return c.json(invalid, 400);
    const now = c.env.now();
    await c.env.db
      .prepare("DELETE FROM link_codes WHERE expires_at <= ?")
      .bind(now.toISOString())
      .run();

    const outstanding = await c.env.db
      .prepare("SELECT COUNT(*) AS count FROM link_codes")
      .first<{ count: number }>();

    if ((outstanding?.count ?? 0) >= MAX_OUTSTANDING_LINK_CODES)
      return c.json({ error: "limit-reached" }, 429);
    const deviceCode = randomToken();
    const deviceCodeHash = await sha256Hex(deviceCode);
    const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS).toISOString();

    // A user code collision is rare; retry a few times against the unique index.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const userCode = createUserCode();

      const inserted = await c.env.db
        .prepare(
          `INSERT INTO link_codes (device_code_hash, user_code, environment_name, server_version, expires_at, created_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM link_codes) < ?
           ON CONFLICT(user_code) DO NOTHING`,
        )
        .bind(
          deviceCodeHash,
          userCode,
          body.environmentName,
          body.serverVersion,
          expiresAt,
          now.toISOString(),
          MAX_OUTSTANDING_LINK_CODES,
        )
        .run();

      if (inserted.meta.changes !== 1) continue;

      const response: CloudLinkStartResponse = {
        deviceCode,
        userCode,
        verificationUrl: `${c.env.config.publicUrl}/link?code=${userCode}`,
        expiresAt,
        pollIntervalSeconds: LINK_POLL_INTERVAL_SECONDS,
      };

      return c.json(response);
    }

    return c.json({ error: "limit-reached" }, 429);
  });

  app.post(CLOUD_LINK_POLL_PATH, async (c) => {
    const body = await decodeJsonBody(c.req.raw, CloudLinkPollRequest);

    if (!body) return c.json(invalid, 400);
    const now = c.env.now().toISOString();
    const deviceCodeHash = await sha256Hex(body.deviceCode);

    const row = await c.env.db
      .prepare("SELECT * FROM link_codes WHERE device_code_hash = ?")
      .bind(deviceCodeHash)
      .first<LinkCodeRow>();

    const respond = (response: CloudLinkPollResponse) => c.json(response);

    if (!row) return respond({ status: "expired" });

    if (row.denied === 1) return respond({ status: "denied" });

    if (!row.approved_user_id) {
      return respond({ status: row.expires_at <= now ? "expired" : "pending" });
    }

    if (row.expires_at <= now) return respond({ status: "expired" });

    const account = await c.env.db
      .prepare("SELECT email FROM users WHERE clerk_user_id = ? AND disabled = 0")
      .bind(row.approved_user_id)
      .first<{ email: string }>();

    if (!account) return respond({ status: "denied" });

    // Domain-separated hashes of the secret device code make the exchange repeatable
    // without storing either secret or deriving the token from its stored device hash.
    const environmentId = `env_${(await sha256Hex(`environment-id:${body.deviceCode}`)).slice(0, 40)}`;
    const environmentToken = await sha256Hex(`environment-token:${body.deviceCode}`);

    const inserted = await c.env.db
      .prepare(`INSERT INTO environments (id, user_id, name, server_version, token_hash, created_at)
        SELECT ?, l.approved_user_id, l.environment_name, l.server_version, ?, ?
        FROM link_codes l JOIN users u ON u.clerk_user_id = l.approved_user_id
        WHERE l.device_code_hash = ? AND l.expires_at > ? AND l.denied = 0 AND u.disabled = 0
        ON CONFLICT(id) DO NOTHING`)
      .bind(environmentId, await sha256Hex(environmentToken), now, deviceCodeHash, now)
      .run();

    const linked = await c.env.db
      .prepare("SELECT 1 FROM environments WHERE id = ? AND revoked_at IS NULL")
      .bind(environmentId)
      .first();

    if (!linked) return respond({ status: "denied" });

    if (inserted.meta.changes === 1)
      c.env.analytics.capture("environment_linked", row.approved_user_id);

    return respond({
      status: "approved",
      environmentId: CloudEnvironmentId.make(environmentId),
      environmentToken,
      account: { email: account.email },
    });
  });

  // Browser side: show what is about to be linked, then approve or deny it.
  app.get("/api/link", requireUser, async (c) => {
    const userCode = normalizeUserCode(c.req.query("code") ?? "");

    if (!userCode) return c.json({ error: "not-found" }, 404);

    const row = await c.env.db
      .prepare(
        "SELECT * FROM link_codes WHERE user_code = ? AND expires_at > ? AND approved_user_id IS NULL AND denied = 0",
      )
      .bind(userCode, c.env.now().toISOString())
      .first<LinkCodeRow>();

    if (!row) return c.json({ error: "not-found" }, 404);

    return c.json({
      userCode: row.user_code,
      environmentName: row.environment_name,
      serverVersion: row.server_version,
      expiresAt: row.expires_at,
    });
  });

  const decide = (decision: "approve" | "deny") =>
    app.post(`/api/link/${decision}`, requireUser, async (c) => {
      const body = await decodeJsonBody(c.req.raw, UserCodeBody);
      const userCode = body ? normalizeUserCode(body.userCode) : null;

      if (!userCode) return c.json(invalid, 400);

      const result = await c.env.db
        .prepare(
          `UPDATE link_codes SET ${decision === "approve" ? "approved_user_id = ?" : "denied = 1"}
           WHERE user_code = ? AND expires_at > ? AND approved_user_id IS NULL AND denied = 0`,
        )
        .bind(
          ...(decision === "approve" ? [c.get("user").userId] : []),
          userCode,
          c.env.now().toISOString(),
        )
        .run();

      if (result.meta.changes !== 1) return c.json({ error: "not-found" }, 404);

      return c.json({ ok: true });
    });

  decide("approve");
  decide("deny");
}
