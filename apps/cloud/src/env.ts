import type { EnvironmentHubRpc } from "./modules/environments/hubRpc.ts";

/**
 * Bindings the Worker receives. Alchemy declares them in
 * `infra/alchemy.run.ts`, which checks that this type matches.
 */
export interface CloudWorkerEnv {
  readonly DB: D1Database;
  readonly HUB: DurableObjectNamespace<EnvironmentHubRpc & Rpc.DurableObjectBranded>;
  readonly CLERK_SECRET_KEY: string;
  readonly CLERK_PUBLISHABLE_KEY: string;
  readonly SLACK_MANAGER_CLIENT_ID: string;
  readonly SLACK_MANAGER_CLIENT_SECRET: string;
  readonly POSTHOG_KEY: string;
  readonly POSTHOG_HOST: string;
  readonly CLOUD_PUBLIC_URL: string;
  readonly KILL_SWITCH: string;
}
