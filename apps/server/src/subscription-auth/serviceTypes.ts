import * as Predicate from "effect/Predicate";
import { SubscriptionBaseUrl, type BotId, type ProviderInstanceId } from "@akeru/contracts";
import * as Schema from "effect/Schema";
import {
  isSubscriptionCredential,
  type SubscriptionAuthData,
  type SubscriptionCredential,
  type SubscriptionCredentialStoreError,
} from "./credentialStore.ts";
import { refreshAnthropicToken } from "./providers/anthropic.ts";
import { refreshCodexToken, type CodexDeviceLoginPending } from "./providers/openaiCodex.ts";
import {
  getKimiCodingDeviceHeaders,
  refreshKimiToken,
  type KimiDeviceLoginPending,
} from "./providers/kimi.ts";
import { refreshXAIToken, type XAIDeviceLoginPending } from "./providers/xai.ts";
import type { OAuthCredential, OAuthCredentials } from "./types.ts";

export const decodeBaseUrl = Schema.decodeUnknownSync(SubscriptionBaseUrl);

/** Anthropic endpoints use an API root; a trailing /v1 is accepted for compatibility. */
export function anthropicApiBaseUrl(baseUrl = "https://api.anthropic.com"): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export const OPENCODE_GO_AUTH_URL = "https://opencode.ai/auth";

export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

export const OPENCODE_GO_USER_AGENT = "akeru-bot/0.0.37";

export const SUBSCRIPTION_PROVIDER_IDS = [
  "anthropic",
  "openai-codex",
  "xai",
  "kimi-for-coding",
  "opencode-go",
] as const;

export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];

export function isSubscriptionProviderId(value: string): value is SubscriptionProviderId {
  return SUBSCRIPTION_PROVIDER_IDS.some((candidate) => candidate === value);
}

/** How a started login is finished: polled by the client, or completed with a pasted code. */
export type LoginCompletion = "poll" | "paste";

export interface StartedLogin {
  loginId: string;
  provider: SubscriptionProviderId;
  /** URL the user opens (in their own browser, on any device). */
  url: string;
  /** Code the user enters on the provider page, for device flows. */
  userCode?: string;
  instructions?: string;
  completion: LoginCompletion;
}

export type LoginPollStatus =
  | { status: "connected"; health?: "checking" }
  | { status: "pending"; nextPollMs: number }
  | { status: "failed"; error: string };

export interface ProviderStatus {
  provider: SubscriptionProviderId;
  instanceId?: ProviderInstanceId;
  connected: boolean;
  accountLabel?: string;
  accountId?: string;
  active?: boolean;
  plan?: string;
  authMode?: "oauth" | "api-key";
  baseUrl?: string;
  /** ms epoch when the current access token expires; refreshed on demand. */
  expiresAt?: number;
  health:
    | "missing"
    | "detected"
    | "healthy"
    | "expired"
    | "revoked"
    | "failed"
    | "failed-first-request"
    | "recovered";
  healthChecking?: boolean;
  lastSuccessfulRequestAt?: string;
  lastFailedRequest?: { at: string; message: string };
  nextRetryAt?: string;
  credentialWarning?: { at: string; message: string };
  reconnectAction: string;
  healthTest: { status: "not-run" | "passed" | "failed"; checkedAt?: string };
  oauthCheck?: { status: "passed" | "failed"; checkedAt: string };
  dependentBots: ReadonlyArray<{ id: BotId; name: string }>;
  dependentRoutines: ReadonlyArray<string>;
}

export interface ProviderHealthRecord {
  lastSuccessfulRequestAt?: string;
  lastCredentialProbeAt?: string;
  lastCredentialProbeFailure?: {
    at: string;
    message: string;
    failureKind: "request" | "revoked";
  };
  // Provider-instance failures also keep the model that failed, so preflight
  // can tell whether the current selection is the one the provider rejected.
  lastFailedRequest?: { at: string; message: string; model?: string };
  nextRetryAt?: string;
  healthTest?: { status: "passed" | "failed"; checkedAt: string };
  oauthCheck?: { status: "passed" | "failed"; checkedAt: string };
  failureKind?: "request" | "revoked";
  /** Set while the post-login health check runs; shared across service instances. */
  healthCheckStartedAt?: string;
  /** Image providers only: the last request that produced an image. */
  lastGenerationAt?: string;
}

/** A post-login check older than this is treated as abandoned (for example, the server restarted). */
export const HEALTH_CHECK_STALE_MS = 60_000;

export const HEALTH_CHECK_TIMEOUT_MS = 30_000;

/** OAuth-only endpoints that prove a subscription token can reach the provider. */
export function oauthHealthRequest(
  provider: SubscriptionProviderId,
  credential: OAuthCredentials,
): { readonly url: string; readonly headers: Record<string, string> } | undefined {
  switch (provider) {
    case "anthropic":
      // Claude Pro/Max OAuth tokens are rejected by /v1/models; the usage endpoint accepts them.
      return {
        url: "https://api.anthropic.com/api/oauth/usage",
        headers: {
          Authorization: `Bearer ${credential.access}`,
          Accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.69",
        },
      };
    case "openai-codex":
      return {
        url: "https://chatgpt.com/backend-api/wham/usage",
        headers: { Authorization: `Bearer ${credential.access}` },
      };
    case "xai":
      return {
        url: "https://api.x.ai/v1/models",
        headers: { Authorization: `Bearer ${credential.access}` },
      };
    case "kimi-for-coding":
      return {
        url: "https://api.kimi.com/coding/v1/models",
        headers: {
          Authorization: `Bearer ${credential.access}`,
          ...getKimiCodingDeviceHeaders(
            Predicate.isString(credential.deviceId) ? credential.deviceId : "",
          ),
        },
      };
    default:
      return undefined;
  }
}

export interface RequestHealthStatus {
  readonly health: "healthy" | "failed" | "failed-first-request" | "recovered";
  readonly lastSuccessfulRequestAt?: string;
  readonly lastFailedRequest?: {
    readonly at: string;
    readonly message: string;
    readonly model?: string;
  };
  readonly nextRetryAt?: string;
}

export type ImageRequestHealthStatus = Omit<RequestHealthStatus, "health"> & {
  readonly health: RequestHealthStatus["health"] | "detected";
  readonly lastCredentialProbeAt?: string;
  readonly lastCredentialProbeFailure?: ProviderHealthRecord["lastCredentialProbeFailure"];
  readonly healthTest?: ProviderHealthRecord["healthTest"];
};

export type ProviderHealthData = Record<string, ProviderHealthRecord | undefined>;

export function oauthFailureKind(cause: unknown): "request" | "revoked" {
  const message = cause instanceof Error ? cause.message : String(cause);

  return /\b(?:invalid_grant|revoked|unauthori[sz]ed|401|403)\b/i.test(message)
    ? "revoked"
    : "request";
}

/** Shown on every row while the store serves the last good state over a damaged file. */
export function lastGoodWarning(error: SubscriptionCredentialStoreError): string {
  return error.reason === "unreadable"
    ? "Saved subscription credentials could not be reread. Akeru Bot keeps using the credentials it loaded earlier. Check the secrets directory permissions."
    : "Saved subscription credentials changed on disk and are damaged. Akeru Bot keeps using the credentials it loaded earlier; the next sign-in or sign-out rewrites the file.";
}

/** Status for every provider when the credential file was damaged before any good load. */
export function storeErrorStatus(
  provider: SubscriptionProviderId,
  lastFailedRequest: { readonly at: string; readonly message: string },
  dependentBots: ReadonlyArray<{
    readonly id: BotId;
    readonly name: string;
    readonly provider: SubscriptionProviderId;
  }>,
): ProviderStatus {
  return {
    provider,
    connected: false,
    health: "failed-first-request",
    lastFailedRequest,
    reconnectAction: provider === "opencode-go" ? "Connect API key" : "Connect account",
    healthTest: { status: "not-run" },
    dependentBots: dependentBots.flatMap((bot) =>
      bot.provider === provider ? [{ id: bot.id, name: bot.name }] : [],
    ),
    dependentRoutines: [],
  };
}

export type PendingLogin =
  | { provider: SubscriptionProviderId; authMode: "api-key"; baseUrl?: string }
  | { provider: "anthropic"; verifier: string }
  | { provider: "openai-codex"; pending: CodexDeviceLoginPending }
  | { provider: "xai"; pending: XAIDeviceLoginPending }
  | { provider: "kimi-for-coding"; pending: KimiDeviceLoginPending }
  | { provider: "opencode-go" };

export type BoundLogin = PendingLogin & { instanceId?: string };

export const defaultInstanceByProvider: Record<SubscriptionProviderId, string> = {
  anthropic: "claudeAgent",
  "openai-codex": "codex",
  xai: "grok",
  "kimi-for-coding": "kimi",
  "opencode-go": "opencodeGo",
};

/** The default instance keeps the bare provider key; other instances get their own account. */
export function credentialKey(provider: SubscriptionProviderId, scope?: string): string {
  if (scope?.startsWith(ACCOUNT_SCOPE_PREFIX)) {
    const accountId = scope.slice(ACCOUNT_SCOPE_PREFIX.length);

    return accountId === DEFAULT_ACCOUNT_ID ? provider : `account:${provider}:${accountId}`;
  }

  return isDefaultScope(provider, scope) ? provider : `instance:${provider}:${scope}`;
}

/** The scope bots on the built-in provider use; it follows the linked-account order. */
export function isDefaultScope(provider: SubscriptionProviderId, scope?: string): boolean {
  return !scope || scope === defaultInstanceByProvider[provider];
}

const ACCOUNT_SCOPE_PREFIX = "account:";

export const DEFAULT_ACCOUNT_ID = "default";

export function accountScope(accountId: string): string {
  return `${ACCOUNT_SCOPE_PREFIX}${accountId}`;
}

export function accountIdForKey(provider: SubscriptionProviderId, key: string): string | undefined {
  if (key === provider) return DEFAULT_ACCOUNT_ID;
  const prefix = `account:${provider}:`;

  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

export function credentialAt(
  data: SubscriptionAuthData,
  key: string,
): SubscriptionCredential | undefined {
  const value = data[key];

  return isSubscriptionCredential(value) ? value : undefined;
}

/** Refreshed tokens keep the stored connection identity and account ID. */
export function refreshedCredential(
  previous: OAuthCredential,
  refreshed: OAuthCredentials,
): OAuthCredential {
  return {
    ...refreshed,
    ...(refreshed.plan === undefined && previous.plan !== undefined ? { plan: previous.plan } : {}),
    type: "oauth",
    ...(refreshed.connectionId === undefined && previous.connectionId !== undefined
      ? { connectionId: previous.connectionId }
      : {}),
    ...(refreshed.accountId === undefined && previous.accountId !== undefined
      ? { accountId: previous.accountId }
      : {}),
  };
}

/** A completed login that the client has not observed yet must not be re-runnable. */
export const PENDING_LOGIN_CAP = 16;

export function runRefresh(
  provider: SubscriptionProviderId,
  credential: OAuthCredential,
): Promise<OAuthCredentials> {
  switch (provider) {
    case "anthropic":
      return refreshAnthropicToken(credential.refresh);
    case "openai-codex":
      return refreshCodexToken(credential);
    case "xai":
      return refreshXAIToken(credential.refresh);
    case "kimi-for-coding":
      return refreshKimiToken(
        credential.refresh,
        undefined,
        Predicate.isString(credential.deviceId) ? credential.deviceId : undefined,
      );
    case "opencode-go":
      throw new Error("OpenCode Go API keys do not refresh.");
  }
}
