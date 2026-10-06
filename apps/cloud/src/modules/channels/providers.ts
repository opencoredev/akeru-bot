import type { CloudHostedChannelProvider, CloudOAuthPurpose } from "@akeru/contracts";

import type { CloudOAuthPurposeHandler } from "./oauth.ts";
import { slackChannel, slackOAuthPurposes } from "./slack/index.ts";

/** What the cloud needs to know to relay one channel provider. */
export interface HostedChannelProviderModule {
  /** Headers forwarded to the environment. Everything else is dropped. */
  readonly forwardsHeader: (lowercaseName: string) => boolean;
  /**
   * Answers provider requests that must succeed before a route exists, such as
   * Slack's URL verification during app creation. Returns null to relay normally.
   */
  readonly preflight?: (body: string) => Response | null;
}

export const hostedChannelProviders: Record<
  CloudHostedChannelProvider,
  HostedChannelProviderModule
> = {
  slack: slackChannel,
};

export const oauthPurposes: Record<CloudOAuthPurpose, CloudOAuthPurposeHandler> = {
  ...slackOAuthPurposes,
};

export function isHostedChannelProvider(value: string): value is CloudHostedChannelProvider {
  return Object.hasOwn(hostedChannelProviders, value);
}
