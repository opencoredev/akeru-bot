import type { CloudWorkerEnv } from "./env.ts";
import { createPostHogAnalytics } from "./analytics.ts";
import { createApp } from "./app.ts";
import { createClerkAuthenticator } from "./auth.ts";
import { readConfig } from "./config.ts";
import type { CloudDeps } from "./deps.ts";
import { runMaintenance } from "./maintenance.ts";

export { EnvironmentHub } from "./modules/environments/hub.ts";

const app = createApp();

function makeDeps(env: CloudWorkerEnv, context: ExecutionContext): CloudDeps {
  const config = readConfig(env);
  const waitUntil = (promise: Promise<unknown>) => context.waitUntil(promise);

  return {
    db: env.DB,
    // The RPC stub's generated type wraps every return value; the hub's methods
    // return plain serializable values, so the declared interface is accurate.
    hubs: {
      get: (environmentId) => env.HUB.getByName(environmentId),
    },
    auth: createClerkAuthenticator({
      secretKey: env.CLERK_SECRET_KEY,
      publishableKey: env.CLERK_PUBLISHABLE_KEY,
      publicUrl: config.publicUrl,
    }),
    analytics: createPostHogAnalytics({ key: env.POSTHOG_KEY, host: env.POSTHOG_HOST, waitUntil }),
    config,
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    waitUntil,
  };
}

export default {
  fetch(request: Request, env: CloudWorkerEnv, context: ExecutionContext): Promise<Response> {
    return Promise.resolve(app.fetch(request, makeDeps(env, context), context));
  },
  async scheduled(
    _controller: ScheduledController,
    env: CloudWorkerEnv,
    _context: ExecutionContext,
  ): Promise<void> {
    await runMaintenance(env.DB, new Date());
  },
};
