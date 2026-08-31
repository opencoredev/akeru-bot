import * as Cloudflare from "alchemy/Cloudflare";

export const FeedbackDatabase = Cloudflare.D1.Database("FeedbackDatabase", {
  migrationsDir: "./migrations",
  primaryLocationHint: "enam",
});
