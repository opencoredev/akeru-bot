import { Hono } from "hono";

import type { CloudHono } from "./deps.ts";
import { registerAccount } from "./modules/account/index.ts";
import { registerAdmin } from "./modules/admin/index.ts";
import { registerChannels } from "./modules/channels/index.ts";
import { registerEnvironments } from "./modules/environments/index.ts";
import { registerHealth } from "./modules/health/index.ts";
import { registerLink } from "./modules/link/index.ts";

/**
 * The cloud's HTTP surface. `/v1/*` is the public protocol for environments and
 * channel providers; `/api/*` is the browser API behind Clerk. Each feature is a
 * module with one register function. Call `app.fetch(request, deps, ctx)`.
 */
export function createApp(): CloudHono {
  const app: CloudHono = new Hono();
  registerHealth(app);
  registerAccount(app);
  registerLink(app);
  registerEnvironments(app);
  registerChannels(app);
  registerAdmin(app);
  app.notFound((c) => c.json({ error: "not-found" }, 404));
  app.onError((error, c) => {
    console.error(JSON.stringify({ event: "cloud.request_failed", error: String(error) }));

    return c.json({ error: "internal" }, 500);
  });

  return app;
}
