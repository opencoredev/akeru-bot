// Vercel routing middleware for the marketing site. Reports page requests to
// Notra GEO (AI crawler and referral analytics) and lets every request through.
import { Tracker } from "@usenotra/geo";

const tracker = new Tracker({
  token: process.env.NOTRA_GEO_TOKEN ?? "",
  endpoint: "https://app.usenotra.com",
});

export default function middleware(
  request: Request,
  context: { waitUntil(promise: Promise<unknown>): void },
): undefined {
  if (!tracker.options.token) return;
  context.waitUntil(tracker.track(request));
}
