import { CLOUD_ENVIRONMENT_SOCKET_PATH } from "@akeru/contracts";

import { requireUser } from "../../auth.ts";
import type { CloudHono } from "../../deps.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { ENVIRONMENT_ID_HEADER, USER_ID_HEADER } from "./hubRpc.ts";
import { revokeEnvironment } from "./revoke.ts";

export function registerEnvironments(app: CloudHono) {
  // The environment's single outbound socket. The token is checked here, then
  // the upgrade is handed to that environment's hub. Authentication errors are
  // returned directly on rejected upgrades; a plain GET supports diagnostics.
  app.get(CLOUD_ENVIRONMENT_SOCKET_PATH, async (c) => {
    const token = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];

    if (!token) return c.text("Unauthorized", 401);

    const row = await c.env.db
      .prepare(
        `SELECT e.id, e.user_id, e.revoked_at, u.disabled FROM environments e
         JOIN users u ON u.clerk_user_id = e.user_id
         WHERE e.token_hash = ?`,
      )
      .bind(await sha256Hex(token))
      .first<{ id: string; user_id: string; revoked_at: string | null; disabled: number }>();

    if (!row) return c.text("Unauthorized", 401);

    // 410 tells the environment to forget its token instead of retrying.
    if (row.revoked_at || row.disabled === 1) return c.text("Gone", 410);

    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.text("Expected a WebSocket upgrade", 426);
    }

    const headers = new Headers(c.req.raw.headers);
    headers.set(ENVIRONMENT_ID_HEADER, row.id);
    headers.set(USER_ID_HEADER, row.user_id);

    return c.env.hubs.get(row.id).fetch(new Request(c.req.raw, { headers }));
  });

  app.post("/api/environments/:id/revoke", requireUser, async (c) => {
    const user = c.get("user");
    const environmentId = c.req.param("id");

    if (!(await revokeEnvironment(c.env.db, c.env.now(), environmentId, user.userId))) {
      return c.json({ error: "not-found" }, 404);
    }

    await c.env.hubs.get(environmentId).revoke();
    c.env.analytics.capture("environment_revoked", user.userId);

    return c.json({ ok: true });
  });
}
