import type { CloudDatabase } from "./database.ts";

const USAGE_RETENTION_DAYS = 90;

const DISABLED_ROUTE_RETENTION_DAYS = 30;

/** Daily cleanup: expired links and OAuth flows, disabled routes, and old usage counters. */
export async function runMaintenance(db: CloudDatabase, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  // Retain expired approval metadata briefly; credentials cannot be delivered after expiry.
  const graceIso = new Date(now.getTime() - 86_400_000).toISOString();

  const usageCutoff = new Date(now.getTime() - USAGE_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const routeCutoff = new Date(
    now.getTime() - DISABLED_ROUTE_RETENTION_DAYS * 86_400_000,
  ).toISOString();

  await db.batch([
    db
      .prepare(
        "UPDATE channel_routes SET disabled_at = ? WHERE disabled = 1 AND disabled_at IS NULL",
      )
      .bind(nowIso),
    db
      .prepare(
        "DELETE FROM oauth_flows WHERE route_id IN (SELECT route_id FROM channel_routes WHERE disabled = 1 AND disabled_at <= ?)",
      )
      .bind(routeCutoff),
    db
      .prepare("DELETE FROM channel_routes WHERE disabled = 1 AND disabled_at <= ?")
      .bind(routeCutoff),
    db.prepare("UPDATE link_codes SET token_ciphertext = NULL WHERE expires_at <= ?").bind(nowIso),
    db
      .prepare("DELETE FROM link_starts WHERE created_at <= ?")
      .bind(new Date(now.getTime() - 60_000).toISOString()),
    db
      .prepare(
        "DELETE FROM link_codes WHERE (approved_user_id IS NULL AND expires_at <= ?) OR expires_at <= ?",
      )
      .bind(nowIso, graceIso),
    db.prepare("DELETE FROM oauth_flows WHERE expires_at <= ?").bind(nowIso),
    db.prepare("DELETE FROM daily_usage WHERE day < ?").bind(usageCutoff),
  ]);
}
