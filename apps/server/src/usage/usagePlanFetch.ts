// @effect-diagnostics nodeBuiltinImport:off
import type { UsageProviderPlanLimits } from "@akeru/contracts";
import {
  CLAUDE_USAGE_URL,
  CODEX_USAGE_URL,
  GROK_CREDITS_URL,
  GROK_SETTINGS_URL,
  KIMI_USAGE_URL,
  type LiveSubscriptionProviderId,
} from "./usagePlanTypes.ts";
import {
  asRecord,
  asNumber,
  asString,
  parseClaudeUsage,
  parseCodexUsage,
  parseGrokUsage,
  parseKimiUsage,
  fetchJson,
} from "./usagePlanParsers.ts";

export async function fetchClaude(accessToken: string): Promise<UsageProviderPlanLimits | null> {
  const result = await fetchJson(CLAUDE_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.69",
    },
  });

  if (result.status < 200 || result.status >= 300) return null;
  const parsed = parseClaudeUsage(result.body);

  if (parsed.windows.length === 0) return null;

  return {
    provider: "anthropic",
    status: "ok",
    plan: parsed.plan,
    message: null,
    windows: [...parsed.windows],
  };
}

export async function fetchCodex(accessToken: string): Promise<UsageProviderPlanLimits | null> {
  const result = await fetchJson(CODEX_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "Akeru Bot",
    },
  });

  if (result.status < 200 || result.status >= 300) return null;
  const primary = asNumber(result.headers.get("x-codex-primary-used-percent"));
  const secondary = asNumber(result.headers.get("x-codex-secondary-used-percent"));

  const parsed = parseCodexUsage(result.body, {
    ...(primary === null ? {} : { primary }),
    ...(secondary === null ? {} : { secondary }),
  });

  if (parsed.windows.length === 0) return null;

  return {
    provider: "openai-codex",
    status: "ok",
    plan: parsed.plan,
    message: null,
    windows: [...parsed.windows],
  };
}

export async function fetchGrok(accessToken: string): Promise<UsageProviderPlanLimits | null> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    Accept: "application/json",
  };

  const [credits, settings] = await Promise.all([
    fetchJson(GROK_CREDITS_URL, { method: "GET", headers }),
    fetchJson(GROK_SETTINGS_URL, { method: "GET", headers }).catch(() => null),
  ]);

  if (credits.status < 200 || credits.status >= 300) return null;
  const parsed = parseGrokUsage(credits.body);

  if (parsed.windows.length === 0) return null;

  const plan =
    parsed.plan ??
    (settings && settings.status >= 200 && settings.status < 300
      ? asString(asRecord(settings.body)?.subscription_tier_display)
      : null);

  return {
    provider: "xai",
    status: "ok",
    plan,
    message: null,
    windows: [...parsed.windows],
  };
}

export async function fetchKimi(accessToken: string): Promise<UsageProviderPlanLimits | null> {
  const result = await fetchJson(KIMI_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (result.status < 200 || result.status >= 300) return null;
  const parsed = parseKimiUsage(result.body);

  if (parsed.windows.length === 0) return null;

  return {
    provider: "kimi-for-coding",
    status: "ok",
    plan: parsed.plan,
    message: null,
    windows: [...parsed.windows],
  };
}

export async function fetchProvider(
  provider: LiveSubscriptionProviderId,
  accessToken: string,
): Promise<UsageProviderPlanLimits | null> {
  switch (provider) {
    case "openai-codex":
      return fetchCodex(accessToken);
    case "anthropic":
      return fetchClaude(accessToken);
    case "xai":
      return fetchGrok(accessToken);
    case "kimi-for-coding":
      return fetchKimi(accessToken);
    case "opencode-go":
      return null;
    default:
      return null;
  }
}
