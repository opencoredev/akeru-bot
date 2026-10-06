import type { CloudDatabase } from "../../database.ts";

/**
 * Marks an environment revoked, disables its routes, and drops its pending
 * OAuth flows. Returns false when the environment is unknown, owned by someone
 * else. Already-revoked environments are safe to retry. The caller closes the hub's socket.
 */
export async function revokeEnvironment(
  db: CloudDatabase,
  now: Date,
  environmentId: string,
  userId: string,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        "UPDATE environments SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?",
      )
      .bind(now.toISOString(), environmentId, userId),
    db
      .prepare(`UPDATE channel_routes SET disabled = 1, disabled_at = COALESCE(disabled_at, ?) WHERE environment_id = ?
      AND EXISTS (SELECT 1 FROM environments WHERE id = ? AND user_id = ?)`)
      .bind(now.toISOString(), environmentId, environmentId, userId),
    db
      .prepare(`DELETE FROM oauth_flows WHERE environment_id = ?
      AND EXISTS (SELECT 1 FROM environments WHERE id = ? AND user_id = ?)`)
      .bind(environmentId, environmentId, userId),
  ]);

  return results[0]?.meta.changes === 1;
}
