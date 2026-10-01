import type { SubscriptionProviderId } from "@akeru/contracts";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

export const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";

export const KIMI_USAGE_URL = "https://www.kimi.com/api/coding/usage";

export const FETCH_TIMEOUT_MS = 10_000;

export const SESSION_MS = 5 * 60 * 60 * 1000;

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type LiveSubscriptionProviderId = SubscriptionProviderId;

export const PLAN_PROVIDER_ORDER: readonly LiveSubscriptionProviderId[] = [
  "openai-codex",
  "anthropic",
  "xai",
  "kimi-for-coding",
  "opencode-go",
];

export interface PlanAccess {
  /** Null while the stored account's token is temporarily unavailable. */
  readonly accessToken: string | null;
  readonly accountId: string;
}

export type GetPlanAccess = (provider: SubscriptionProviderId) => Promise<PlanAccess | undefined>;
