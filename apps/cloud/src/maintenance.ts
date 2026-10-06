import type { CloudDatabase } from "./database.ts";

const USAGE_RETENTION_DAYS = 90;

/** Daily cleanup: expired link codes and OAuth flows, and old usage counters. */
export async function runMaintenance(db: CloudDatabase, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  // Approved codes get a day's grace so an environment that was asleep can still claim them.
  const graceIso = new Date(now.getTime() - 86_400_000).toISOString();

  const usageCutoff = new Date(now.getTime() - USAGE_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  await db.batch([
    db
      .prepare(
        "DELETE FROM link_codes WHERE (approved_user_id IS NULL AND expires_at <= ?) OR expires_at <= ?",
      )
      .bind(nowIso, graceIso),
    db.prepare("DELETE FROM oauth_flows WHERE expires_at <= ?").bind(nowIso),
    db.prepare("DELETE FROM daily_usage WHERE day < ?").bind(usageCutoff),
  ]);
}
