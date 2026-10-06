import type { CloudDatabase } from "../../database.ts";

/**
 * Marks an environment revoked, disables its routes, and drops its pending
 * OAuth flows. Returns false when the environment is unknown, owned by someone
 * else, or already revoked. The caller closes the hub's socket.
 */
export async function revokeEnvironment(
  db: CloudDatabase,
  now: Date,
  environmentId: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE environments SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(now.toISOString(), environmentId, userId)
    .run();

  if (result.meta.changes !== 1) return false;
  await db.batch([
    db
      .prepare("UPDATE channel_routes SET disabled = 1 WHERE environment_id = ?")
      .bind(environmentId),
    db.prepare("DELETE FROM oauth_flows WHERE environment_id = ?").bind(environmentId),
  ]);

  return true;
}
