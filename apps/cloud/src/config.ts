import type { CloudWorkerEnv } from "./env.ts";

export interface CloudConfig {
  /** Origin the cloud is reachable at, without a trailing slash. */
  readonly publicUrl: string;
  readonly clerkPublishableKey: string;
  /** Akeru's Slack manager app. Null until its credentials are configured. */
  readonly slackManager: { readonly clientId: string; readonly clientSecret: string } | null;
  /** When set, hosted channel relaying answers 503. */
  readonly killSwitch: boolean;
}

export function readConfig(
  env: Pick<
    CloudWorkerEnv,
    | "CLOUD_PUBLIC_URL"
    | "CLERK_PUBLISHABLE_KEY"
    | "SLACK_MANAGER_CLIENT_ID"
    | "SLACK_MANAGER_CLIENT_SECRET"
    | "KILL_SWITCH"
  >,
): CloudConfig {
  return {
    publicUrl: env.CLOUD_PUBLIC_URL.replace(/\/+$/, ""),
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY,
    slackManager:
      env.SLACK_MANAGER_CLIENT_ID && env.SLACK_MANAGER_CLIENT_SECRET
        ? {
            clientId: env.SLACK_MANAGER_CLIENT_ID,
            clientSecret: env.SLACK_MANAGER_CLIENT_SECRET,
          }
        : null,
    killSwitch: env.KILL_SWITCH !== "" && env.KILL_SWITCH !== "0" && env.KILL_SWITCH !== "false",
  };
}

export const oauthCallbackUrl = (config: CloudConfig) => `${config.publicUrl}/v1/oauth/callback`;
