import { requireUser } from "../../auth.ts";
import type { CloudHono } from "../../deps.ts";

interface EnvironmentRow {
  readonly id: string;
  readonly name: string;
  readonly server_version: string;
  readonly created_at: string;
  readonly last_seen_at: string | null;
  readonly revoked_at: string | null;
}

interface RouteRow {
  readonly route_id: string;
  readonly provider: string;
  readonly environment_id: string;
  readonly label: string;
  readonly external_workspace_name: string | null;
  readonly created_at: string;
  readonly last_event_at: string | null;
  readonly disabled: number;
}

export function registerAccount(app: CloudHono) {
  // Public, so the SPA can start Clerk without a build-time key.
  app.get("/api/config", (c) => c.json({ clerkPublishableKey: c.env.config.clerkPublishableKey }));

  app.get("/api/me", requireUser, async (c) => {
    const user = c.get("user");

    const [environments, routes] = await Promise.all([
      c.env.db
        .prepare(
          "SELECT id, name, server_version, created_at, last_seen_at, revoked_at FROM environments WHERE user_id = ? ORDER BY created_at DESC",
        )
        .bind(user.userId)
        .all<EnvironmentRow>(),
      c.env.db
        .prepare(
          "SELECT route_id, provider, environment_id, label, external_workspace_name, created_at, last_event_at, disabled FROM channel_routes WHERE user_id = ? ORDER BY created_at DESC",
        )
        .bind(user.userId)
        .all<RouteRow>(),
    ]);

    const online = await Promise.all(
      environments.results.map((row) =>
        row.revoked_at ? false : c.env.hubs.get(row.id).isOnline(),
      ),
    );

    return c.json({
      account: { email: user.email, isAdmin: user.isAdmin },
      environments: environments.results.map((row, index) => ({
        id: row.id,
        name: row.name,
        serverVersion: row.server_version,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        status: row.revoked_at ? "revoked" : online[index] ? "online" : "offline",
      })),
      routes: routes.results.map((row) => ({
        routeId: row.route_id,
        provider: row.provider,
        environmentId: row.environment_id,
        label: row.label,
        workspaceName: row.external_workspace_name,
        createdAt: row.created_at,
        lastEventAt: row.last_event_at,
        disabled: row.disabled === 1,
      })),
    });
  });
}
