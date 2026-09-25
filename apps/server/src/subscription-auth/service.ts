// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off
/**
 * Subscription auth service: one API over OAuth and API-key login flows.
 *
 * Storage follows Mastra Code's `AuthStorage` (mastra-ai/mastra,
 * `mastracode/sdk/src/auth/storage.ts`, Apache-2.0): a mode-0600 JSON file of
 * Provider credentials. They live in the server's secrets directory, never inside
 * a workspace or sandbox. Provider runtimes request credentials from this
 * service and do not copy refresh credentials into a sandbox.
 *
 * Login flows are client-driven: `start` returns a URL (and user code) to
 * show, then the client calls `poll` until the flow settles. Every pending
 * state is JSON-serializable, so a login survives a server restart and any
 * replica can continue it.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  SubscriptionBaseUrl,
  type BotId,
  type SubscriptionAuthStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  subscriptionCredentialStore,
  type SubscriptionAuthData,
  type SubscriptionCredentialStore,
  type SubscriptionCredentialStoreError,
} from "./credentialStore.ts";

import {
  completeAnthropicLogin,
  refreshAnthropicToken,
  startAnthropicLogin,
} from "./providers/anthropic.ts";
import {
  pollCodexDeviceLogin,
  refreshCodexToken,
  startCodexDeviceLogin,
  type CodexDeviceLoginPending,
} from "./providers/openaiCodex.ts";
import {
  getKimiCodingDeviceHeaders,
  isKimiCodingDeviceId,
  pollKimiDeviceLogin,
  refreshKimiToken,
  startKimiDeviceLogin,
  type KimiDeviceLoginPending,
} from "./providers/kimi.ts";
import {
  pollXAIDeviceLogin,
  refreshXAIToken,
  startXAIDeviceLogin,
  type XAIDeviceLoginPending,
} from "./providers/xai.ts";
import type { ApiKeyCredential, OAuthCredential, OAuthCredentials } from "./types.ts";

const decodeBaseUrl = Schema.decodeUnknownSync(SubscriptionBaseUrl);

/** Anthropic endpoints use an API root; a trailing /v1 is accepted for compatibility. */
export function anthropicApiBaseUrl(baseUrl = "https://api.anthropic.com"): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

const OPENCODE_GO_AUTH_URL = "https://opencode.ai/auth";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_USER_AGENT = "akeru-bot/0.0.37";

export const SUBSCRIPTION_PROVIDER_IDS = [
  "anthropic",
  "openai-codex",
  "cursor",
  "xai",
  "kimi-for-coding",
  "opencode-go",
] as const;

export type SubscriptionProviderId = (typeof SUBSCRIPTION_PROVIDER_IDS)[number];

export function isSubscriptionProviderId(value: string): value is SubscriptionProviderId {
  return (SUBSCRIPTION_PROVIDER_IDS as readonly string[]).includes(value);
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
  connected: boolean;
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

interface ProviderHealthRecord {
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
}

/** A post-login check older than this is treated as abandoned (for example, the server restarted). */
const HEALTH_CHECK_STALE_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 30_000;

/** OAuth-only endpoints that prove a subscription token can reach the provider. */
function oauthHealthRequest(
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
            typeof credential.deviceId === "string" ? credential.deviceId : "",
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

type ImageRequestHealthStatus = Omit<RequestHealthStatus, "health"> & {
  readonly health: RequestHealthStatus["health"] | "detected";
  readonly lastCredentialProbeAt?: string;
  readonly lastCredentialProbeFailure?: ProviderHealthRecord["lastCredentialProbeFailure"];
  readonly healthTest?: ProviderHealthRecord["healthTest"];
};

type ProviderHealthData = Record<string, ProviderHealthRecord | undefined>;

function oauthFailureKind(cause: unknown): "request" | "revoked" {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /\b(?:invalid_grant|revoked|unauthori[sz]ed|401|403)\b/i.test(message)
    ? "revoked"
    : "request";
}

/** Shown on every row while the store serves the last good state over a damaged file. */
function lastGoodWarning(error: SubscriptionCredentialStoreError): string {
  return error.reason === "unreadable"
    ? "Saved subscription credentials could not be reread. Akeru Bot keeps using the credentials it loaded earlier. Check the secrets directory permissions."
    : "Saved subscription credentials changed on disk and are damaged. Akeru Bot keeps using the credentials it loaded earlier; the next sign-in or sign-out rewrites the file.";
}

/** Status for every provider when the credential file was damaged before any good load. */
function storeErrorStatus(
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
    dependentBots: dependentBots
      .filter((bot) => bot.provider === provider)
      .map(({ id, name }) => ({ id, name })),
    dependentRoutines: [],
  };
}

type PendingLogin =
  | { provider: SubscriptionProviderId; authMode: "api-key"; baseUrl?: string }
  | { provider: "anthropic"; verifier: string }
  | { provider: "openai-codex"; pending: CodexDeviceLoginPending }
  | { provider: "xai"; pending: XAIDeviceLoginPending }
  | { provider: "kimi-for-coding"; pending: KimiDeviceLoginPending }
  | { provider: "opencode-go" };

/** A completed login that the client has not observed yet must not be re-runnable. */
const PENDING_LOGIN_CAP = 16;

export class SubscriptionAuthService {
  private readonly authPath: string;
  private readonly store: SubscriptionCredentialStore;
  private readonly pendingPath: string;
  private readonly healthPath: string;
  private health: ProviderHealthData = {};
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly refreshInFlight = new Map<string, Promise<string | undefined>>();
  private readonly healthChecks = new Map<SubscriptionProviderId, Promise<void>>();
  private readonly healthProbeVersions = new Map<SubscriptionProviderId, number>();
  private readonly checkHealthOnConnect: boolean;

  /**
   * `checkHealthOnConnect` runs a provider health check on the server as soon as a
   * login stores credentials, so the result does not depend on the client staying connected.
   */
  private constructor(
    store: SubscriptionCredentialStore,
    options: { readonly checkHealthOnConnect?: boolean },
  ) {
    this.store = store;
    this.authPath = store.path;
    this.checkHealthOnConnect = options.checkHealthOnConnect ?? false;
    this.pendingPath = `${this.authPath}.pending`;
    this.healthPath = `${this.authPath}.health`;
    this.reloadLocal();
  }

  /** A service over the credential file at `authPath`, loaded from disk. */
  static make(
    authPath: string,
    options: { readonly checkHealthOnConnect?: boolean } = {},
  ): Effect.Effect<SubscriptionAuthService, never, FileSystem.FileSystem | Path.Path> {
    return Effect.gen(function* () {
      const store = yield* subscriptionCredentialStore(authPath);
      yield* store.reload;
      return new SubscriptionAuthService(store, options);
    });
  }

  static forSecretsDir(
    secretsDir: string,
    options?: { readonly checkHealthOnConnect?: boolean },
  ): Effect.Effect<SubscriptionAuthService, never, FileSystem.FileSystem | Path.Path> {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      return yield* SubscriptionAuthService.make(
        path.join(secretsDir, "subscription-auth.json"),
        options,
      );
    });
  }

  /** Reread credentials, pending logins, and health from disk. */
  reload(): Effect.Effect<void> {
    return this.store.reload.pipe(Effect.andThen(Effect.sync(() => this.reloadLocal())));
  }

  private reloadAsync(): Promise<void> {
    return Effect.runPromise(this.reload());
  }

  private get data(): SubscriptionAuthData {
    return this.store.current().data;
  }

  private updateCredentials(
    f: (data: SubscriptionAuthData) => SubscriptionAuthData,
  ): Promise<SubscriptionAuthData> {
    return Effect.runPromise(this.store.update(f));
  }

  private reloadLocal(): void {
    this.reloadHealth();

    this.pendingLogins.clear();
    if (!NodeFS.existsSync(this.pendingPath)) return;
    try {
      const entries = JSON.parse(NodeFS.readFileSync(this.pendingPath, "utf-8")) as Array<
        readonly [string, PendingLogin]
      >;
      for (const [loginId, pending] of entries.slice(-PENDING_LOGIN_CAP)) {
        // Cursor sign-in was retired; a login saved before the upgrade reports
        // as expired instead of polling a provider this build cannot finish.
        if (pending.provider === "cursor") continue;
        this.pendingLogins.set(loginId, pending);
      }
    } catch {
      this.pendingLogins.clear();
    }
  }

  private reloadHealth(): void {
    if (!NodeFS.existsSync(this.healthPath)) {
      this.health = {};
      return;
    }
    try {
      this.health = JSON.parse(NodeFS.readFileSync(this.healthPath, "utf-8")) as ProviderHealthData;
    } catch {
      this.health = {};
    }
  }

  private writeSecureJson(filePath: string, value: unknown): void {
    const dir = NodePath.dirname(filePath);
    if (!NodeFS.existsSync(dir)) {
      NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tempPath = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
    NodeFS.writeFileSync(tempPath, JSON.stringify(value, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    NodeFS.renameSync(tempPath, filePath);
    NodeFS.chmodSync(filePath, 0o600);
  }

  private savePending(): void {
    this.writeSecureJson(this.pendingPath, [...this.pendingLogins.entries()]);
  }

  private saveHealth(): void {
    this.writeSecureJson(this.healthPath, this.health);
  }

  statuses(
    dependentBots: ReadonlyArray<{
      readonly id: BotId;
      readonly name: string;
      readonly provider: SubscriptionProviderId;
    }> = [],
    now = Date.now(),
  ): ProviderStatus[] {
    const { data, loadError, loadErrorAt, servingLastGood } = this.store.current();
    const damagedAt = loadErrorAt ?? new Date(now).toISOString();
    const credentialWarning =
      loadError && servingLastGood
        ? { at: damagedAt, message: lastGoodWarning(loadError) }
        : undefined;
    return SUBSCRIPTION_PROVIDER_IDS.map((provider) => {
      if (loadError && !servingLastGood) {
        return storeErrorStatus(
          provider,
          { at: damagedAt, message: loadError.message },
          dependentBots,
        );
      }
      const credential = data[provider];
      const health = this.health[provider];
      const expired = credential?.type === "oauth" && credential.expires <= now;
      const failedAfterSuccess =
        health?.lastFailedRequest !== undefined &&
        (health.lastSuccessfulRequestAt === undefined ||
          health.lastFailedRequest.at >= health.lastSuccessfulRequestAt);
      const recovered =
        health?.lastSuccessfulRequestAt !== undefined &&
        health.lastFailedRequest !== undefined &&
        health.lastSuccessfulRequestAt > health.lastFailedRequest.at;
      const checking =
        health?.healthCheckStartedAt !== undefined &&
        now - Date.parse(health.healthCheckStartedAt) < HEALTH_CHECK_STALE_MS;
      const state = !credential
        ? "missing"
        : failedAfterSuccess
          ? health?.failureKind === "revoked"
            ? "revoked"
            : health?.lastSuccessfulRequestAt
              ? "failed"
              : "failed-first-request"
          : expired
            ? "expired"
            : recovered
              ? "recovered"
              : health?.lastSuccessfulRequestAt
                ? "healthy"
                : "detected";
      return {
        provider,
        connected: credential !== undefined,
        ...(credential ? { authMode: credential.type } : {}),
        ...(credential?.type === "api-key" && credential.baseUrl
          ? { baseUrl: credential.baseUrl }
          : {}),
        ...(credential?.type === "oauth" ? { expiresAt: credential.expires } : {}),
        health: state,
        ...(credential && checking ? { healthChecking: true } : {}),
        ...(health?.lastSuccessfulRequestAt
          ? { lastSuccessfulRequestAt: health.lastSuccessfulRequestAt }
          : {}),
        ...(health?.lastFailedRequest ? { lastFailedRequest: health.lastFailedRequest } : {}),
        ...(health?.nextRetryAt ? { nextRetryAt: health.nextRetryAt } : {}),
        ...(credentialWarning ? { credentialWarning } : {}),
        reconnectAction:
          credential?.type === "api-key" || provider === "opencode-go"
            ? credential
              ? "Replace API key"
              : "Connect API key"
            : credential
              ? "Reconnect account"
              : "Connect account",
        healthTest: health?.healthTest ?? { status: "not-run" },
        ...(health?.oauthCheck ? { oauthCheck: health.oauthCheck } : {}),
        dependentBots: dependentBots
          .filter((bot) => bot.provider === provider)
          .map(({ id, name }) => ({ id, name })),
        dependentRoutines: [],
      };
    });
  }

  recordRequestSuccess(provider: SubscriptionProviderId, at = new Date().toISOString()): void {
    this.recordHealthSuccess(provider, at);
  }

  recordProviderInstanceSuccess(instanceId: string, at = new Date().toISOString()): void {
    this.recordHealthSuccess(`provider:${instanceId}`, at);
  }

  private recordHealthSuccess(key: string, at: string): void {
    this.reloadHealth();
    const previous = this.health[key];
    const {
      nextRetryAt: _nextRetryAt,
      lastCredentialProbeFailure: _probeFailure,
      ...rest
    } = previous ?? {};
    this.health[key] = {
      ...rest,
      lastSuccessfulRequestAt: at,
      healthTest: { status: "passed", checkedAt: at },
    };
    this.saveHealth();
  }

  recordRequestFailure(
    provider: SubscriptionProviderId,
    message: string,
    at = new Date().toISOString(),
    failureKind: "request" | "revoked" = "request",
  ): void {
    this.recordHealthFailure(provider, message, at, failureKind);
  }

  recordProviderInstanceFailure(
    instanceId: string,
    message: string,
    at = new Date().toISOString(),
    model?: string,
  ): void {
    this.recordHealthFailure(`provider:${instanceId}`, message, at, "request", model);
  }

  recordMcpRequestSuccess(serverId: string, at = new Date().toISOString()): void {
    this.recordHealthSuccess(`mcp:${serverId}`, at);
  }

  recordMcpRequestFailure(serverId: string, message: string, at = new Date().toISOString()): void {
    this.recordHealthFailure(`mcp:${serverId}`, message, at, "request");
  }

  recordImageRequestSuccess(provider: "chatgpt" | "grok", at = new Date().toISOString()): void {
    this.recordHealthSuccess(`image:${provider}`, at);
  }

  recordImageCredentialProbeSuccess(
    provider: "chatgpt" | "grok",
    at = new Date().toISOString(),
  ): void {
    this.reloadHealth();
    const key = `image:${provider}`;
    const { lastCredentialProbeFailure: _failure, ...previous } = this.health[key] ?? {};
    this.health[key] = {
      ...previous,
      lastCredentialProbeAt: at,
      healthTest: { status: "passed", checkedAt: at },
    };
    this.saveHealth();
  }

  recordImageCredentialProbeFailure(
    provider: "chatgpt" | "grok",
    message: string,
    at = new Date().toISOString(),
    failureKind: "request" | "revoked" = "request",
  ): void {
    message = this.redactHealthMessage(message);
    const key = `image:${provider}`;
    this.health[key] = {
      ...this.health[key],
      lastCredentialProbeFailure: {
        at,
        message,
        failureKind,
      },
      healthTest: { status: "failed", checkedAt: at },
    };
    this.saveHealth();
  }

  recordImageRequestFailure(
    provider: "chatgpt" | "grok",
    message: string,
    at = new Date().toISOString(),
    failureKind: "request" | "revoked" = "request",
  ): void {
    this.recordHealthFailure(`image:${provider}`, message, at, failureKind);
  }

  /** Image-provider request health, keyed separately from the chat driver. */
  imageRequestHealth(provider: "chatgpt" | "grok"): ImageRequestHealthStatus | undefined {
    const key = `image:${provider}`;
    const requestHealth = this.requestHealth(key);
    const record = this.health[key];
    if (!record) return requestHealth;
    return {
      ...(requestHealth ?? { health: "detected" }),
      ...(record.lastCredentialProbeAt
        ? { lastCredentialProbeAt: record.lastCredentialProbeAt }
        : {}),
      ...(record.lastCredentialProbeFailure
        ? { lastCredentialProbeFailure: record.lastCredentialProbeFailure }
        : {}),
      ...(record.healthTest ? { healthTest: record.healthTest } : {}),
    };
  }

  private redactHealthMessage(message: string): string {
    this.reloadHealth();
    for (const provider of SUBSCRIPTION_PROVIDER_IDS) {
      const credential = this.data[provider];
      if (!credential) continue;
      for (const secret of [
        credential.access,
        credential.type === "oauth" ? credential.refresh : undefined,
      ]) {
        if (secret) message = message.replaceAll(secret, "[redacted]");
      }
    }
    return message;
  }

  private recordHealthFailure(
    key: string,
    message: string,
    at: string,
    failureKind: "request" | "revoked",
    model?: string,
  ): void {
    message = this.redactHealthMessage(message);
    const { nextRetryAt: _nextRetryAt, ...previous } = this.health[key] ?? {};
    this.health[key] = {
      ...previous,
      lastFailedRequest: { at, message, ...(model ? { model } : {}) },
      failureKind,
      healthTest: { status: "failed", checkedAt: at },
    };
    this.saveHealth();
  }

  providerInstanceHealth(
    instanceId: string,
  ): "healthy" | "failed" | "failed-first-request" | "recovered" | undefined {
    return this.requestHealth(`provider:${instanceId}`)?.health;
  }

  providerInstanceRequestHealth(instanceId: string): RequestHealthStatus | undefined {
    return this.requestHealth(`provider:${instanceId}`);
  }

  mcpRequestHealth(serverId: string): RequestHealthStatus | undefined {
    return this.requestHealth(`mcp:${serverId}`);
  }

  private requestHealth(key: string): RequestHealthStatus | undefined {
    const health = this.health[key];
    if (!health) return undefined;
    if (
      health.lastFailedRequest &&
      (!health.lastSuccessfulRequestAt ||
        health.lastFailedRequest.at > health.lastSuccessfulRequestAt ||
        (health.lastFailedRequest.at === health.lastSuccessfulRequestAt &&
          health.healthTest?.status === "failed"))
    ) {
      return {
        health: health.lastSuccessfulRequestAt ? "failed" : "failed-first-request",
        ...(health.lastSuccessfulRequestAt
          ? { lastSuccessfulRequestAt: health.lastSuccessfulRequestAt }
          : {}),
        lastFailedRequest: health.lastFailedRequest,
        ...(health.nextRetryAt ? { nextRetryAt: health.nextRetryAt } : {}),
      };
    }
    if (
      health.lastSuccessfulRequestAt &&
      health.lastFailedRequest &&
      (health.lastSuccessfulRequestAt > health.lastFailedRequest.at ||
        (health.lastSuccessfulRequestAt === health.lastFailedRequest.at &&
          health.healthTest?.status === "passed"))
    ) {
      return {
        health: "recovered",
        lastSuccessfulRequestAt: health.lastSuccessfulRequestAt,
        lastFailedRequest: health.lastFailedRequest,
        ...(health.nextRetryAt ? { nextRetryAt: health.nextRetryAt } : {}),
      };
    }
    return health.lastSuccessfulRequestAt
      ? {
          health: "healthy",
          lastSuccessfulRequestAt: health.lastSuccessfulRequestAt,
          ...(health.lastFailedRequest ? { lastFailedRequest: health.lastFailedRequest } : {}),
          ...(health.nextRetryAt ? { nextRetryAt: health.nextRetryAt } : {}),
        }
      : undefined;
  }

  private async isCurrentHealthCredential(
    provider: SubscriptionProviderId,
    credential: ApiKeyCredential | OAuthCredential,
    version: number,
  ): Promise<boolean> {
    if (this.healthProbeVersions.get(provider) !== version) return false;
    await this.reloadAsync();
    if (this.healthProbeVersions.get(provider) !== version) return false;
    const current = this.data[provider];
    if (current?.type !== credential.type || current.access !== credential.access) return false;
    return credential.type === "api-key"
      ? current.type === "api-key" && current.baseUrl === credential.baseUrl
      : current.type === "oauth" && current.refresh === credential.refresh;
  }

  async testHealth(provider: SubscriptionProviderId): Promise<void> {
    await this.reloadAsync();
    if (provider === "cursor") return;
    const version = (this.healthProbeVersions.get(provider) ?? 0) + 1;
    this.healthProbeVersions.set(provider, version);
    const credential = this.data[provider];
    if (!credential) {
      this.recordOAuthFailure(
        provider,
        this.store.current().loadError?.message ?? "No account is connected.",
      );
      return;
    }
    if (credential.type === "api-key") {
      const defaultBaseUrls: Partial<Record<SubscriptionProviderId, string>> = {
        anthropic: "https://api.anthropic.com/v1",
        "openai-codex": "https://api.openai.com/v1",
        xai: "https://api.x.ai/v1",
        "kimi-for-coding": "https://api.kimi.com/coding/v1",
        "opencode-go": "https://opencode.ai/zen/go/v1",
      };
      const url =
        provider === "opencode-go" && !credential.baseUrl
          ? OPENCODE_GO_USAGE_URL
          : provider === "anthropic"
            ? `${anthropicApiBaseUrl(credential.baseUrl)}/v1/models`
            : `${credential.baseUrl ?? defaultBaseUrls[provider]}/models`;
      try {
        const response = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
          headers: {
            ...(provider === "anthropic"
              ? { "x-api-key": credential.access, "anthropic-version": "2023-06-01" }
              : { Authorization: `Bearer ${credential.access}` }),
            "User-Agent": OPENCODE_GO_USER_AGENT,
            ...(provider === "opencode-go" ? { "x-opencode-client": "akeru-bot" } : {}),
          },
        });
        if (!(await this.isCurrentHealthCredential(provider, credential, version))) return;
        if (!response.ok) {
          this.recordRequestFailure(
            provider,
            `The provider rejected the API-key check (${response.status}).`,
            undefined,
            response.status === 401 || response.status === 403 ? "revoked" : "request",
          );
        } else {
          this.recordRequestSuccess(provider);
        }
      } catch {
        if (!(await this.isCurrentHealthCredential(provider, credential, version))) return;
        this.recordRequestFailure(
          provider,
          "The API-key check failed. Check the base URL and connection.",
        );
      }
      return;
    }
    let testedCredential = credential;
    try {
      const refreshed =
        credential.expires > Date.now() ? credential : await this.runRefresh(provider, credential);
      if (!(await this.isCurrentHealthCredential(provider, credential, version))) return;
      await this.setCredential(provider, refreshed);
      testedCredential = { type: "oauth", ...refreshed };
      const request = oauthHealthRequest(provider, refreshed);
      if (!request) throw new Error("This subscription does not expose a health endpoint.");
      const response = await fetch(request.url, {
        redirect: "error",
        headers: request.headers,
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!(await this.isCurrentHealthCredential(provider, testedCredential, version))) return;
      if (!response.ok) {
        throw new Error(`The provider rejected the health request (${response.status}).`);
      }
      this.recordRequestSuccess(provider);
      const checkedAt = new Date().toISOString();
      this.reloadHealth();
      this.health[provider] = {
        ...this.health[provider],
        oauthCheck: { status: "passed", checkedAt },
      };
      this.saveHealth();
    } catch (cause) {
      if (!(await this.isCurrentHealthCredential(provider, testedCredential, version))) return;
      this.recordRequestFailure(
        provider,
        cause instanceof Error ? cause.message : "The provider rejected the health request.",
        undefined,
        oauthFailureKind(cause),
      );
    }
  }

  /**
   * Start the post-login health check in the background. It keeps running when the
   * client that finished the login disconnects; `awaitHealthCheck` observes it.
   */
  private startHealthCheck(provider: SubscriptionProviderId): LoginPollStatus {
    if (!this.checkHealthOnConnect) return { status: "connected" };
    this.reloadHealth();
    this.health[provider] = {
      ...this.health[provider],
      healthCheckStartedAt: new Date().toISOString(),
    };
    this.saveHealth();
    const check = this.testHealth(provider)
      .finally(() => {
        if (this.healthChecks.get(provider) !== check) return;
        this.reloadHealth();
        const current = this.health[provider];
        if (current?.healthCheckStartedAt === undefined) return;
        const { healthCheckStartedAt: _startedAt, ...rest } = current;
        this.health[provider] = rest;
        this.saveHealth();
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.healthChecks.get(provider) === check) this.healthChecks.delete(provider);
      });
    this.healthChecks.set(provider, check);
    return { status: "connected", health: "checking" };
  }

  /** Resolves when the post-login health check for `provider` has recorded its result. */
  awaitHealthCheck(provider: SubscriptionProviderId): Promise<void> {
    return this.healthChecks.get(provider) ?? Promise.resolve();
  }

  private recordOAuthFailure(
    provider: SubscriptionProviderId,
    message: string,
    failureKind: "request" | "revoked" = "request",
  ): void {
    const checkedAt = new Date().toISOString();
    this.reloadHealth();
    const { nextRetryAt: _nextRetryAt, ...previous } = this.health[provider] ?? {};
    this.health[provider] = {
      ...previous,
      lastFailedRequest: { at: checkedAt, message },
      failureKind,
      oauthCheck: { status: "failed", checkedAt },
    };
    this.saveHealth();
  }

  isConnected(provider: SubscriptionProviderId): boolean {
    return this.data[provider] !== undefined;
  }

  hasOpenAICodexAccount(): boolean {
    const credential = this.data["openai-codex"];
    return (
      credential?.type === "oauth" &&
      typeof credential.accountId === "string" &&
      credential.accountId.length > 0
    );
  }

  async startLogin(
    provider: SubscriptionProviderId,
    options: Omit<SubscriptionAuthStartInput, "provider"> = {},
  ): Promise<StartedLogin> {
    await this.reloadAsync();
    if (provider === "cursor") {
      throw new Error("Cursor authentication is not supported in this build.");
    }
    const authMode = options.authMode ?? (provider === "opencode-go" ? "api-key" : "oauth");
    if (options.baseUrl !== undefined && authMode !== "api-key") {
      throw new Error("Custom base URLs require API-key authentication. Select API key first.");
    }
    if (options.baseUrl !== undefined && provider === "xai") {
      throw new Error(
        "The Grok bridge does not support custom base URLs. Use the default endpoint.",
      );
    }
    if (authMode === "oauth" && provider === "opencode-go") {
      throw new Error("OpenCode Go requires an API key. Select API key first.");
    }
    const baseUrl =
      options.baseUrl === undefined
        ? undefined
        : decodeBaseUrl(options.baseUrl).replace(/\/+$/, "");
    const loginId = NodeCrypto.randomUUID();
    let started: StartedLogin;

    if (authMode === "api-key") {
      this.pendingLogins.set(loginId, { provider, authMode, ...(baseUrl ? { baseUrl } : {}) });
      started = {
        loginId,
        provider,
        url: provider === "opencode-go" ? OPENCODE_GO_AUTH_URL : "",
        instructions: "Paste the provider API key.",
        completion: "paste",
      };
    } else
      switch (provider) {
        case "anthropic": {
          const { url, verifier } = await startAnthropicLogin();
          this.pendingLogins.set(loginId, { provider, verifier });
          started = { loginId, provider, url, completion: "paste" };
          break;
        }
        case "openai-codex": {
          const pending = await startCodexDeviceLogin();
          this.pendingLogins.set(loginId, { provider, pending });
          started = {
            loginId,
            provider,
            url: pending.url,
            userCode: pending.userCode,
            instructions: pending.instructions,
            completion: "poll",
          };
          break;
        }
        case "xai": {
          const pending = await startXAIDeviceLogin();
          this.pendingLogins.set(loginId, { provider, pending });
          started = {
            loginId,
            provider,
            url: pending.url,
            userCode: pending.userCode,
            instructions: pending.instructions,
            completion: "poll",
          };
          break;
        }
        case "kimi-for-coding": {
          const pending = await startKimiDeviceLogin();
          this.pendingLogins.set(loginId, { provider, pending });
          started = {
            loginId,
            provider,
            url: pending.url,
            userCode: pending.userCode,
            instructions: pending.instructions,
            completion: "poll",
          };
          break;
        }
        case "opencode-go": {
          this.pendingLogins.set(loginId, { provider });
          started = {
            loginId,
            provider,
            url: OPENCODE_GO_AUTH_URL,
            instructions: "Subscribe to OpenCode Go, copy the API key, then paste it here.",
            completion: "paste",
          };
          break;
        }
      }

    // Drop the oldest abandoned login rather than growing without bound.
    if (this.pendingLogins.size > PENDING_LOGIN_CAP) {
      const oldest = this.pendingLogins.keys().next().value;
      if (oldest !== undefined) this.pendingLogins.delete(oldest);
    }
    this.savePending();

    return started;
  }

  /** One upstream poll for a started login. Persists credentials on success. */
  async pollLogin(loginId: string): Promise<LoginPollStatus> {
    await this.reloadAsync();
    const login = this.pendingLogins.get(loginId);
    if (!login) {
      return { status: "failed", error: "Login expired or already completed. Start again." };
    }

    if ("authMode" in login) return { status: "pending", nextPollMs: 2000 };

    switch (login.provider) {
      case "anthropic":
        return { status: "pending", nextPollMs: 2000 };
      case "openai-codex": {
        const result = await pollCodexDeviceLogin(login.pending);
        return this.foldPoll(loginId, login.provider, result);
      }
      case "xai": {
        const result = await pollXAIDeviceLogin(login.pending);
        if (result.status === "pending") {
          this.pendingLogins.set(loginId, { provider: "xai", pending: result.pending });
          this.savePending();
        }
        return this.foldPoll(loginId, login.provider, result);
      }
      case "kimi-for-coding": {
        const result = await pollKimiDeviceLogin(login.pending);
        if (result.status === "pending") {
          this.pendingLogins.set(loginId, { provider: "kimi-for-coding", pending: result.pending });
          this.savePending();
        }
        return this.foldPoll(loginId, login.provider, result);
      }
      case "opencode-go":
        return { status: "pending", nextPollMs: 2000 };
    }
  }

  private async foldPoll(
    loginId: string,
    provider: SubscriptionProviderId,
    result:
      | { status: "complete"; credentials: OAuthCredentials }
      | { status: "pending"; nextPollMs: number }
      | { status: "pending"; nextPollMs: number; pending: unknown }
      | { status: "failed"; error: string },
  ): Promise<LoginPollStatus> {
    switch (result.status) {
      case "complete":
        await this.reloadAsync();
        if (!this.pendingLogins.has(loginId))
          return { status: "failed", error: "Login cancelled. Start again." };
        this.pendingLogins.delete(loginId);
        this.savePending();
        await this.setCredential(provider, result.credentials, true);
        return this.startHealthCheck(provider);
      case "failed":
        this.pendingLogins.delete(loginId);
        this.savePending();
        return { status: "failed", error: result.error };
      case "pending":
        return { status: "pending", nextPollMs: result.nextPollMs };
    }
  }

  /** Finish a paste-completion login (Anthropic) with the pasted code. */
  async completeLogin(loginId: string, code: string): Promise<LoginPollStatus> {
    await this.reloadAsync();
    const login = this.pendingLogins.get(loginId);
    if (!login) {
      return { status: "failed", error: "Login expired or already completed. Start again." };
    }
    if ("authMode" in login || login.provider === "opencode-go") {
      const apiKey = code.trim();
      if (apiKey.length === 0 || /[\r\n]/.test(apiKey)) {
        return { status: "failed", error: "Paste a non-empty API key on one line." };
      }
      const baseUrl = "baseUrl" in login ? login.baseUrl : undefined;
      const provider = login.provider;
      await this.updateCredentials((data) => ({
        ...data,
        [provider]: {
          type: "api-key",
          access: apiKey,
          connectionId: NodeCrypto.randomUUID(),
          ...(baseUrl ? { baseUrl } : {}),
        },
      }));
      this.reloadLocal();
      delete this.health[provider];
      this.clearImageHealth(provider);
      this.saveHealth();
      for (const [id, pending] of this.pendingLogins) {
        if (pending.provider === login.provider) this.pendingLogins.delete(id);
      }
      this.savePending();
      return this.startHealthCheck(login.provider);
    }
    if (login.provider !== "anthropic") {
      return { status: "failed", error: "This login completes by polling, not with a code." };
    }

    try {
      const credentials = await completeAnthropicLogin(code, login.verifier);
      await this.reloadAsync();
      if (!this.pendingLogins.has(loginId))
        return { status: "failed", error: "Login cancelled. Start again." };
      this.pendingLogins.delete(loginId);
      this.savePending();
      await this.setCredential("anthropic", credentials, true);
      return this.startHealthCheck("anthropic");
    } catch (error) {
      // Keep the pending login: a mangled paste should not force a restart.
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  cancelLogin(loginId: string): void {
    this.reloadLocal();
    this.pendingLogins.delete(loginId);
    this.savePending();
  }

  async logout(provider: SubscriptionProviderId): Promise<void> {
    this.reloadLocal();
    for (const [loginId, pending] of this.pendingLogins) {
      if (pending.provider === provider) this.pendingLogins.delete(loginId);
    }
    this.savePending();
    await this.updateCredentials(({ [provider]: _removed, ...rest }) => rest);
    this.reloadHealth();
    delete this.health[provider];
    this.clearImageHealth(provider);
    this.saveHealth();
  }

  private clearImageHealth(provider: SubscriptionProviderId): void {
    if (provider === "openai-codex") delete this.health["image:chatgpt"];
    if (provider === "xai") delete this.health["image:grok"];
  }

  private async setCredential(
    provider: SubscriptionProviderId,
    credentials: OAuthCredentials,
    replacement = false,
  ): Promise<void> {
    if (replacement || this.data[provider]?.type === "api-key") {
      this.reloadHealth();
      delete this.health[provider];
      this.clearImageHealth(provider);
      this.saveHealth();
    }
    await this.updateCredentials((data) => {
      const previous = data[provider];
      return {
        ...data,
        [provider]: {
          ...credentials,
          type: "oauth",
          connectionId: replacement
            ? NodeCrypto.randomUUID()
            : (previous?.connectionId ?? NodeCrypto.randomUUID()),
          ...(!replacement &&
          previous?.type === "oauth" &&
          credentials.accountId === undefined &&
          previous.accountId !== undefined
            ? { accountId: previous.accountId }
            : {}),
        },
      };
    });
  }

  /**
   * Ready-to-use access token for a provider, refreshing first when expired.
   * Concurrent callers share one refresh; a failed refresh clears nothing —
   * the user re-connects from Settings.
   */
  async getAccessToken(provider: SubscriptionProviderId): Promise<string | undefined> {
    const credential = this.data[provider];
    if (!credential) return undefined;

    if (credential.type === "api-key") return credential.access;

    if (Date.now() < credential.expires) {
      return credential.access;
    }

    const inFlight = this.refreshInFlight.get(provider);
    if (inFlight) return inFlight;

    const refresh = this.refreshCredential(provider, credential).finally(() => {
      this.refreshInFlight.delete(provider);
    });
    this.refreshInFlight.set(provider, refresh);
    return refresh;
  }

  async getPlanAccessToken(provider: SubscriptionProviderId): Promise<string | undefined> {
    const apiKey = this.getApiKeyCredential(provider);
    if (apiKey && (provider !== "opencode-go" || apiKey.baseUrl)) return undefined;
    return this.getAccessToken(provider);
  }

  /**
   * The stored plan account and its access token. `accessToken` is null while the token is
   * temporarily unavailable, so callers still know which account is connected.
   */
  async getPlanAccess(
    provider: SubscriptionProviderId,
  ): Promise<{ readonly accessToken: string | null; readonly accountId: string } | undefined> {
    await this.reloadAsync();
    const credential = this.data[provider];
    if (
      !credential ||
      (credential.type === "api-key" && (provider !== "opencode-go" || credential.baseUrl))
    )
      return undefined;
    if (typeof credential.connectionId !== "string" || !credential.connectionId) {
      await this.updateCredentials((data) => {
        const current = data[provider];
        if (!current || (typeof current.connectionId === "string" && current.connectionId))
          return data;
        return { ...data, [provider]: { ...current, connectionId: NodeCrypto.randomUUID() } };
      });
    }
    const accessToken = await this.getPlanAccessToken(provider).catch(() => undefined);
    await this.reloadAsync();
    const current = this.data[provider];
    if (!current) return undefined;
    const accountId =
      current.type === "oauth" && typeof current.accountId === "string" && current.accountId
        ? current.accountId
        : current.connectionId;
    if (typeof accountId !== "string" || !accountId)
      throw new Error("Plan account identity is unavailable.");
    return { accessToken: accessToken ? current.access : null, accountId };
  }

  getApiKeyCredential(provider: SubscriptionProviderId): ApiKeyCredential | undefined {
    const credential = this.data[provider];
    return credential?.type === "api-key" ? credential : undefined;
  }

  async getOpenAICodexAccess(): Promise<
    { readonly accessToken: string; readonly accountId: string } | undefined
  > {
    await this.reloadAsync();
    const accessToken = await this.getAccessToken("openai-codex");
    const credential = this.data["openai-codex"];
    const accountId = credential?.type === "oauth" ? credential.accountId : undefined;
    return accessToken && typeof accountId === "string" && accountId.length > 0
      ? { accessToken, accountId }
      : undefined;
  }

  async getKimiForCodingAccess(): Promise<
    | { readonly accessToken: string; readonly deviceId?: string; readonly baseUrl?: string }
    | undefined
  > {
    await this.reloadAsync();
    const accessToken = await this.getAccessToken("kimi-for-coding");
    const credential = this.data["kimi-for-coding"];
    if (credential?.type === "api-key" && accessToken) {
      return { accessToken, ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}) };
    }
    const deviceId = credential?.type === "oauth" ? credential.deviceId : undefined;
    return accessToken && isKimiCodingDeviceId(deviceId) ? { accessToken, deviceId } : undefined;
  }

  private async refreshCredential(
    provider: SubscriptionProviderId,
    credential: OAuthCredential,
  ): Promise<string | undefined> {
    try {
      const refreshed = await this.runRefresh(provider, credential);
      await this.reloadAsync();
      const current = this.data[provider];
      if (current?.type !== "oauth" || current.refresh !== credential.refresh) {
        return current?.access;
      }
      await this.setCredential(provider, refreshed);
      return refreshed.access;
    } catch (cause) {
      // Refresh failed — the user must re-connect. Keep the stored credential
      // so status still shows which account was linked.
      this.recordOAuthFailure(
        provider,
        cause instanceof Error ? cause.message : "The provider rejected the token refresh.",
        oauthFailureKind(cause),
      );
      return undefined;
    }
  }

  private runRefresh(
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
          typeof credential.deviceId === "string" ? credential.deviceId : undefined,
        );
      case "opencode-go":
        throw new Error("OpenCode Go API keys do not refresh.");
      case "cursor":
        throw new Error("Cursor authentication is not supported in this build.");
    }
  }
}
