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
import * as Schema from "effect/Schema";

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
  pollCursorLogin,
  refreshCursorToken,
  startCursorLogin,
  type CursorLoginPending,
} from "./providers/cursor.ts";
import {
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
import type {
  ApiKeyCredential,
  OAuthCredential,
  OAuthCredentials,
  SubscriptionAuthData,
} from "./types.ts";

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
  | { status: "connected" }
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
  lastSuccessfulRequestAt?: string;
  lastFailedRequest?: { at: string; message: string };
  nextRetryAt?: string;
  reconnectAction: string;
  healthTest: { status: "not-run" | "passed" | "failed"; checkedAt?: string };
  oauthCheck?: { status: "passed" | "failed"; checkedAt: string };
  dependentBots: ReadonlyArray<{ id: BotId; name: string }>;
  dependentRoutines: ReadonlyArray<string>;
}

interface ProviderHealthRecord {
  lastSuccessfulRequestAt?: string;
  lastFailedRequest?: { at: string; message: string };
  nextRetryAt?: string;
  healthTest?: { status: "passed" | "failed"; checkedAt: string };
  oauthCheck?: { status: "passed" | "failed"; checkedAt: string };
  failureKind?: "request" | "revoked";
}

export interface RequestHealthStatus {
  readonly health: "healthy" | "failed" | "failed-first-request" | "recovered";
  readonly lastSuccessfulRequestAt?: string;
  readonly lastFailedRequest?: { readonly at: string; readonly message: string };
  readonly nextRetryAt?: string;
}

type ProviderHealthData = Record<string, ProviderHealthRecord | undefined>;

function oauthFailureKind(cause: unknown): "request" | "revoked" {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /\b(?:invalid_grant|revoked|unauthori[sz]ed|401|403)\b/i.test(message)
    ? "revoked"
    : "request";
}

type PendingLogin =
  | { provider: SubscriptionProviderId; authMode: "api-key"; baseUrl?: string }
  | { provider: "anthropic"; verifier: string }
  | { provider: "openai-codex"; pending: CodexDeviceLoginPending }
  | { provider: "cursor"; pending: CursorLoginPending }
  | { provider: "xai"; pending: XAIDeviceLoginPending }
  | { provider: "kimi-for-coding"; pending: KimiDeviceLoginPending }
  | { provider: "opencode-go" };

/** A completed login that the client has not observed yet must not be re-runnable. */
const PENDING_LOGIN_CAP = 16;

export class SubscriptionAuthService {
  private data: SubscriptionAuthData = {};
  private readonly authPath: string;
  private readonly pendingPath: string;
  private readonly healthPath: string;
  private health: ProviderHealthData = {};
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly refreshInFlight = new Map<string, Promise<string | undefined>>();

  constructor(authPath: string) {
    this.authPath = authPath;
    this.pendingPath = `${authPath}.pending`;
    this.healthPath = `${authPath}.health`;
    this.reload();
  }

  static forSecretsDir(secretsDir: string): SubscriptionAuthService {
    return new SubscriptionAuthService(NodePath.join(secretsDir, "subscription-auth.json"));
  }

  reload(): void {
    if (!NodeFS.existsSync(this.authPath)) {
      this.data = {};
    } else {
      try {
        this.data = JSON.parse(NodeFS.readFileSync(this.authPath, "utf-8")) as SubscriptionAuthData;
      } catch {
        this.data = {};
      }
    }

    this.reloadHealth();

    this.pendingLogins.clear();
    if (!NodeFS.existsSync(this.pendingPath)) return;
    try {
      const entries = JSON.parse(NodeFS.readFileSync(this.pendingPath, "utf-8")) as Array<
        readonly [string, PendingLogin]
      >;
      for (const [loginId, pending] of entries.slice(-PENDING_LOGIN_CAP)) {
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

  private save(): void {
    this.writeSecureJson(this.authPath, this.data);
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
    return SUBSCRIPTION_PROVIDER_IDS.map((provider) => {
      const credential = this.data[provider];
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
        ...(health?.lastSuccessfulRequestAt
          ? { lastSuccessfulRequestAt: health.lastSuccessfulRequestAt }
          : {}),
        ...(health?.lastFailedRequest ? { lastFailedRequest: health.lastFailedRequest } : {}),
        ...(health?.nextRetryAt ? { nextRetryAt: health.nextRetryAt } : {}),
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
    const { nextRetryAt: _nextRetryAt, ...rest } = previous ?? {};
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
  ): void {
    this.recordHealthFailure(`provider:${instanceId}`, message, at, "request");
  }

  recordMcpRequestSuccess(serverId: string, at = new Date().toISOString()): void {
    this.recordHealthSuccess(`mcp:${serverId}`, at);
  }

  recordMcpRequestFailure(serverId: string, message: string, at = new Date().toISOString()): void {
    this.recordHealthFailure(`mcp:${serverId}`, message, at, "request");
  }

  private recordHealthFailure(
    key: string,
    message: string,
    at: string,
    failureKind: "request" | "revoked",
  ): void {
    this.reload();
    const { nextRetryAt: _nextRetryAt, ...previous } = this.health[key] ?? {};
    for (const credential of Object.values(this.data)) {
      for (const secret of [
        credential.access,
        credential.type === "oauth" ? credential.refresh : undefined,
      ]) {
        if (secret) message = message.replaceAll(secret, "[redacted]");
      }
    }
    this.health[key] = {
      ...previous,
      lastFailedRequest: { at, message },
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

  async testHealth(provider: SubscriptionProviderId): Promise<void> {
    this.reload();
    const credential = this.data[provider];
    if (!credential) {
      this.recordOAuthFailure(provider, "No account is connected.");
      return;
    }
    if (credential.type === "api-key") {
      const defaultBaseUrls: Record<SubscriptionProviderId, string> = {
        anthropic: "https://api.anthropic.com/v1",
        "openai-codex": "https://api.openai.com/v1",
        cursor: "https://api.cursor.com",
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
          headers: {
            ...(provider === "anthropic"
              ? { "x-api-key": credential.access, "anthropic-version": "2023-06-01" }
              : { Authorization: `Bearer ${credential.access}` }),
            "User-Agent": OPENCODE_GO_USER_AGENT,
            ...(provider === "opencode-go" ? { "x-opencode-client": "akeru-bot" } : {}),
          },
        });
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
        this.recordRequestFailure(
          provider,
          "The API-key check failed. Check the base URL and connection.",
        );
      }
      return;
    }
    try {
      const refreshed = await this.runRefresh(provider, credential);
      this.reload();
      const current = this.data[provider];
      if (current?.type !== "oauth" || current.refresh !== credential.refresh) return;
      this.setCredential(provider, refreshed);
      // Refresh proves the OAuth grant is usable. It does not prove that the
      // subscription can make a model request, so keep access detected until
      // the runtime records the first successful provider request.
      const checkedAt = new Date().toISOString();
      this.reloadHealth();
      this.health[provider] = {
        ...this.health[provider],
        oauthCheck: { status: "passed", checkedAt },
      };
      this.saveHealth();
    } catch (cause) {
      this.recordOAuthFailure(
        provider,
        cause instanceof Error ? cause.message : "The provider rejected the health request.",
        oauthFailureKind(cause),
      );
    }
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

  async startLogin(
    provider: SubscriptionProviderId,
    options: Omit<SubscriptionAuthStartInput, "provider"> = {},
  ): Promise<StartedLogin> {
    this.reload();
    const authMode = options.authMode ?? (provider === "opencode-go" ? "api-key" : "oauth");
    if (options.baseUrl !== undefined && authMode !== "api-key") {
      throw new Error("Custom base URLs require API-key authentication. Select API key first.");
    }
    if (authMode === "api-key" && provider === "cursor") {
      throw new Error("Cursor API-key authentication is not supported. Use OAuth.");
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
        case "cursor": {
          const pending = await startCursorLogin();
          this.pendingLogins.set(loginId, { provider, pending });
          started = {
            loginId,
            provider,
            url: pending.url,
            instructions: "Approve the Cursor login in your browser.",
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
    this.reload();
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
      case "cursor": {
        const result = await pollCursorLogin(login.pending);
        if (result.status === "pending") {
          this.pendingLogins.set(loginId, { provider: "cursor", pending: result.pending });
          this.savePending();
        }
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

  private foldPoll(
    loginId: string,
    provider: SubscriptionProviderId,
    result:
      | { status: "complete"; credentials: OAuthCredentials }
      | { status: "pending"; nextPollMs: number }
      | { status: "pending"; nextPollMs: number; pending: unknown }
      | { status: "failed"; error: string },
  ): LoginPollStatus {
    switch (result.status) {
      case "complete":
        this.reload();
        if (!this.pendingLogins.has(loginId))
          return { status: "failed", error: "Login cancelled. Start again." };
        this.pendingLogins.delete(loginId);
        this.savePending();
        this.setCredential(provider, result.credentials);
        return { status: "connected" };
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
    this.reload();
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
      this.reload();
      this.data[login.provider] = {
        type: "api-key",
        access: apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      };
      delete this.health[login.provider];
      this.save();
      this.saveHealth();
      for (const [id, pending] of this.pendingLogins) {
        if (pending.provider === login.provider) this.pendingLogins.delete(id);
      }
      this.savePending();
      return { status: "connected" };
    }
    if (login.provider !== "anthropic") {
      return { status: "failed", error: "This login completes by polling, not with a code." };
    }

    try {
      const credentials = await completeAnthropicLogin(code, login.verifier);
      this.reload();
      if (!this.pendingLogins.has(loginId))
        return { status: "failed", error: "Login cancelled. Start again." };
      this.pendingLogins.delete(loginId);
      this.savePending();
      this.setCredential("anthropic", credentials);
      return { status: "connected" };
    } catch (error) {
      // Keep the pending login: a mangled paste should not force a restart.
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  cancelLogin(loginId: string): void {
    this.reload();
    this.pendingLogins.delete(loginId);
    this.savePending();
  }

  logout(provider: SubscriptionProviderId): void {
    this.reload();
    for (const [loginId, pending] of this.pendingLogins) {
      if (pending.provider === provider) this.pendingLogins.delete(loginId);
    }
    this.savePending();
    delete this.data[provider];
    this.reloadHealth();
    delete this.health[provider];
    this.save();
    this.saveHealth();
  }

  private setCredential(provider: SubscriptionProviderId, credentials: OAuthCredentials): void {
    if (this.data[provider]?.type === "api-key") {
      this.reloadHealth();
      delete this.health[provider];
      this.saveHealth();
    }
    this.data[provider] = { type: "oauth", ...credentials };
    this.save();
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

  getApiKeyCredential(provider: SubscriptionProviderId): ApiKeyCredential | undefined {
    this.reload();
    const credential = this.data[provider];
    return credential?.type === "api-key" ? credential : undefined;
  }

  async getOpenAICodexAccess(): Promise<
    { readonly accessToken: string; readonly accountId: string } | undefined
  > {
    this.reload();
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
    this.reload();
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
      this.reload();
      const current = this.data[provider];
      if (current?.type !== "oauth" || current.refresh !== credential.refresh) {
        return current?.access;
      }
      this.setCredential(provider, refreshed);
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
      case "cursor":
        return refreshCursorToken(credential);
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
    }
  }
}
