import * as Cloudflare from "alchemy/Cloudflare";

// The pinned name matches the database from the first production deploy, so a
// checkout without prior state adopts it instead of creating a new one.
export const FeedbackDatabase = Cloudflare.D1.Database("FeedbackDatabase", {
  name: "AkeruFeedback-FeedbackDatabase-production-miv7ua5r3iswqssa",
  migrationsDir: "./migrations",
  primaryLocationHint: "enam",
});
