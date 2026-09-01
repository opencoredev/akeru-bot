import { defineConfig } from "astro/config";

// Absolute URLs for canonical and OpenGraph tags. Vercel supplies the
// production host on preview builds, so previews link their own origin.
const site =
  process.env.SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "https://www.akeru-bot.com");

export default defineConfig({
  site,
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
