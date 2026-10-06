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
import {
  createUserCode,
  normalizeUserCode,
  randomId,
  randomToken,
  sha256Hex,
} from "../../lib/crypto.ts";
import { openLinkToken, sealLinkToken } from "./tokenDelivery.ts";
import { decodeJsonBody } from "../../lib/schema.ts";

export const LINK_CODE_TTL_MS = 10 * 60_000;

export const LINK_POLL_INTERVAL_SECONDS = 3;

export const MAX_OUTSTANDING_LINK_CODES = 10000;

export const LINK_DELIVERY_GRACE_MS = 30_000;

export const MAX_CALLER_OUTSTANDING = 5;

export const MAX_CALLER_STARTS = 10;

const UserCodeBody = Schema.Struct({ userCode: Schema.String.check(Schema.isMaxLength(32)) });

interface LinkCodeRow {
  readonly user_code: string;
  readonly environment_name: string;
  readonly server_version: string;
  readonly expires_at: string;
  readonly approved_user_id: string | null;
  readonly denied: number;
  readonly environment_id: string | null;
  readonly token_hash: string | null;
  readonly token_ciphertext: string | null;
  readonly delivery_expires_at: string | null;
}

const invalid = { error: "invalid-request" } as const;

/**
 * Device link. The environment starts a flow and polls with its device code;
 * the user approves the short user code in the browser. Only the hash of the
 * device code is stored. The independent token is hashed for authentication
 * and encrypted for a bounded delivery grace period.
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

    await c.env.db
      .prepare("UPDATE link_codes SET token_ciphertext = NULL WHERE delivery_expires_at <= ?")
      .bind(now.toISOString())
      .run();
    const caller = await sha256Hex(c.req.header("CF-Connecting-IP") ?? "local");
    const windowStart = new Date(now.getTime() - 60_000).toISOString();
    await c.env.db.prepare("DELETE FROM link_starts WHERE created_at <= ?").bind(windowStart).run();

    const admission = await c.env.db
      .prepare(`INSERT INTO link_starts (caller_hash, created_at)
      SELECT ?, ? WHERE (SELECT COUNT(*) FROM link_starts WHERE caller_hash = ?) < ?
      AND (SELECT COUNT(*) FROM link_codes WHERE caller_hash = ?) < ?`)
      .bind(caller, now.toISOString(), caller, MAX_CALLER_STARTS, caller, MAX_CALLER_OUTSTANDING)
      .run();

    if (admission.meta.changes !== 1) return c.json({ error: "limit-reached" }, 429);
    const deviceCode = randomToken();
    const deviceCodeHash = await sha256Hex(deviceCode);
    const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS).toISOString();

    // A user code collision is rare; retry a few times against the unique index.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const userCode = createUserCode();

      const inserted = await c.env.db
        .prepare(
          `INSERT INTO link_codes (device_code_hash, user_code, environment_name, server_version, expires_at, created_at, caller_hash)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM link_codes) < ?
           AND (SELECT COUNT(*) FROM link_codes WHERE caller_hash = ?) < ?
           ON CONFLICT(user_code) DO NOTHING`,
        )
        .bind(
          deviceCodeHash,
          userCode,
          body.environmentName,
          body.serverVersion,
          expiresAt,
          now.toISOString(),
          caller,
          MAX_OUTSTANDING_LINK_CODES,
          caller,
          MAX_CALLER_OUTSTANDING,
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

    if (!row.token_ciphertext || !row.environment_id || !row.token_hash)
      return respond({ status: "expired" });

    if (row.delivery_expires_at && row.delivery_expires_at <= now) {
      await c.env.db
        .prepare("UPDATE link_codes SET token_ciphertext = NULL WHERE device_code_hash = ?")
        .bind(deviceCodeHash)
        .run();

      return respond({ status: "expired" });
    }

    const environmentId = row.environment_id;

    const environmentToken = await openLinkToken(
      c.env.config.linkDeliverySecret,
      row.token_ciphertext,
    );

    const inserted = await c.env.db
      .prepare(`INSERT INTO environments (id, user_id, name, server_version, token_hash, created_at)
        SELECT ?, l.approved_user_id, l.environment_name, l.server_version, ?, ?
        FROM link_codes l JOIN users u ON u.clerk_user_id = l.approved_user_id
        WHERE l.device_code_hash = ? AND l.expires_at > ? AND l.denied = 0 AND u.disabled = 0
        ON CONFLICT(id) DO NOTHING`)
      .bind(environmentId, row.token_hash, now, deviceCodeHash, now)
      .run();

    const linked = await c.env.db
      .prepare("SELECT 1 FROM environments WHERE id = ? AND revoked_at IS NULL")
      .bind(environmentId)
      .first();

    if (!linked) return respond({ status: "denied" });

    if (inserted.meta.changes === 1)
      c.env.analytics.capture("environment_linked", row.approved_user_id);

    await c.env.db
      .prepare(`UPDATE link_codes SET delivery_expires_at = COALESCE(delivery_expires_at, ?)
      WHERE device_code_hash = ?`)
      .bind(new Date(c.env.now().getTime() + LINK_DELIVERY_GRACE_MS).toISOString(), deviceCodeHash)
      .run();

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

      const token = decision === "approve" ? randomToken() : null;

      const credentials = token
        ? [
            randomId("env"),
            await sha256Hex(token),
            await sealLinkToken(c.env.config.linkDeliverySecret, token),
          ]
        : [];

      const result = await c.env.db
        .prepare(
          `UPDATE link_codes SET ${decision === "approve" ? "approved_user_id = ?, environment_id = ?, token_hash = ?, token_ciphertext = ?" : "denied = 1"}
           WHERE user_code = ? AND expires_at > ? AND approved_user_id IS NULL AND denied = 0`,
        )
        .bind(
          ...(decision === "approve" ? [c.get("user").userId, ...credentials] : []),
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
