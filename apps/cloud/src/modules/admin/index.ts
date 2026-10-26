import { requireAdmin, requireUser } from "../../auth.ts";
import type { CloudHono } from "../../deps.ts";

const LIST_LIMIT = 200;

const USAGE_DAYS = 7;

export function registerAdmin(app: CloudHono) {
  app.get("/api/admin/overview", requireUser, requireAdmin, async (c) => {
    const db = c.env.db;

    const since = new Date(c.env.now().getTime() - (USAGE_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const [totals, users, environments, routes, usage] = await Promise.all([
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM users) AS users,
             (SELECT COUNT(*) FROM environments WHERE revoked_at IS NULL) AS environments,
             (SELECT COUNT(*) FROM channel_routes WHERE disabled = 0) AS routes`,
        )
        .first<{ users: number; environments: number; routes: number }>(),
      db
        .prepare(
          `SELECT u.clerk_user_id, u.email, u.created_at, u.disabled,
             (SELECT COUNT(*) FROM environments e WHERE e.user_id = u.clerk_user_id AND e.revoked_at IS NULL) AS environment_count,
             (SELECT COUNT(*) FROM channel_routes r WHERE r.user_id = u.clerk_user_id) AS route_count
           FROM users u ORDER BY u.created_at DESC LIMIT ?`,
        )
        .bind(LIST_LIMIT)
        .all<{
          clerk_user_id: string;
          email: string;
          created_at: string;
          disabled: number;
          environment_count: number;
          route_count: number;
        }>(),
      db
        .prepare(
          `SELECT e.id, e.name, e.server_version, e.created_at, e.last_seen_at, e.revoked_at, u.email
           FROM environments e JOIN users u ON u.clerk_user_id = e.user_id
           ORDER BY e.created_at DESC LIMIT ?`,
        )
        .bind(LIST_LIMIT)
        .all<{
          id: string;
          name: string;
          server_version: string;
          created_at: string;
          last_seen_at: string | null;
          revoked_at: string | null;
          email: string;
        }>(),
      db
        .prepare(
          `SELECT r.route_id, r.provider, r.label, r.external_workspace_name, r.created_at,
             r.last_event_at, r.disabled, u.email,
             COALESCE(SUM(d.delivered), 0) AS delivered, COALESCE(SUM(d.dropped), 0) AS dropped
           FROM channel_routes r
           JOIN users u ON u.clerk_user_id = r.user_id
           LEFT JOIN daily_usage d ON d.route_id = r.route_id AND d.day >= ?
           GROUP BY r.route_id ORDER BY r.created_at DESC LIMIT ?`,
        )
        .bind(since, LIST_LIMIT)
        .all<{
          route_id: string;
          provider: string;
          label: string;
          external_workspace_name: string | null;
          created_at: string;
          last_event_at: string | null;
          disabled: number;
          email: string;
          delivered: number;
          dropped: number;
        }>(),
      db
        .prepare(
          `SELECT day, SUM(delivered) AS delivered, SUM(dropped) AS dropped
           FROM daily_usage WHERE day >= ? GROUP BY day ORDER BY day`,
        )
        .bind(since)
        .all<{ day: string; delivered: number; dropped: number }>(),
    ]);

    return c.json({
      totals: totals ?? { users: 0, environments: 0, routes: 0 },
      users: users.results.map((row) => ({
        userId: row.clerk_user_id,
        email: row.email,
        createdAt: row.created_at,
        disabled: row.disabled === 1,
        environments: row.environment_count,
        routes: row.route_count,
      })),
      environments: environments.results.map((row) => ({
        id: row.id,
        name: row.name,
        serverVersion: row.server_version,
        email: row.email,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        revokedAt: row.revoked_at,
      })),
      routes: routes.results.map((row) => ({
        routeId: row.route_id,
        provider: row.provider,
        label: row.label,
        workspaceName: row.external_workspace_name,
        email: row.email,
        createdAt: row.created_at,
        lastEventAt: row.last_event_at,
        disabled: row.disabled === 1,
        delivered: row.delivered,
        dropped: row.dropped,
      })),
      usage: usage.results,
    });
  });
}
