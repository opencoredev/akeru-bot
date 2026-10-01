import { decodeProviderHealth } from "./persistedSchemas.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import { type SubscriptionAuthData, type SubscriptionCredentialStore } from "./credentialStore.ts";
import type { ApiKeyCredential, OAuthCredential } from "./types.ts";
import {
  anthropicApiBaseUrl,
  OPENCODE_GO_USAGE_URL,
  OPENCODE_GO_USER_AGENT,
  type SubscriptionProviderId,
  type LoginPollStatus,
  HEALTH_CHECK_TIMEOUT_MS,
  oauthHealthRequest,
  type RequestHealthStatus,
  type ImageRequestHealthStatus,
  type ProviderHealthData,
  oauthFailureKind,
  credentialKey,
  credentialAt,
  refreshedCredential,
  runRefresh,
} from "./serviceTypes.ts";

export class SubscriptionHealthService {
  private readonly store: SubscriptionCredentialStore;
  constructor(store: SubscriptionCredentialStore, checkHealthOnConnect: boolean) {
    this.store = store;
    this.healthPath = store.path + ".health";
    this.checkHealthOnConnect = checkHealthOnConnect;
  }
  private get data() {
    return this.store.current().data;
  }
  private reloadAsync() {
    return Effect.runPromise(this.store.reload);
  }
  private updateCredentials(update: (data: SubscriptionAuthData) => SubscriptionAuthData) {
    return Effect.runPromise(this.store.update(update));
  }

  public readonly healthPath: string;

  public health: ProviderHealthData = {};

  public readonly healthChecks = new Map<string, Promise<void>>();

  public readonly healthProbeVersions = new Map<string, number>();

  public readonly checkHealthOnConnect: boolean;

  public reloadHealth(): void {
    if (!NodeFS.existsSync(this.healthPath)) {
      this.health = {};

      return;
    }

    try {
      this.health = decodeProviderHealth(NodeFS.readFileSync(this.healthPath, "utf-8"));
    } catch {
      this.health = {};
    }
  }

  public writeSecureJson<Value>(filePath: string, value: Value): void {
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

  public saveHealth(): void {
    this.writeSecureJson(this.healthPath, this.health);
  }

  recordRequestSuccess(provider: SubscriptionProviderId, at = new Date().toISOString()): void {
    this.recordHealthSuccess(provider, at);
  }

  recordAccountRequestSuccess(
    provider: SubscriptionProviderId,
    instanceId: string,
    at: string,
  ): void {
    this.recordHealthSuccess(credentialKey(provider, instanceId), at);
  }

  recordProviderInstanceSuccess(instanceId: string, at = new Date().toISOString()): void {
    this.recordHealthSuccess(`provider:${instanceId}`, at);
  }

  public recordHealthSuccess(key: string, at: string): void {
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

  recordAccountRequestFailure(
    provider: SubscriptionProviderId,
    instanceId: string,
    message: string,
    at: string,
  ): void {
    this.recordHealthFailure(credentialKey(provider, instanceId), message, at, "request");
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

  /** A completed image generation, which also proves the provider healthy. */
  recordImageGenerationSuccess(provider: "chatgpt" | "grok", at = new Date().toISOString()): void {
    this.recordHealthSuccess(`image:${provider}`, at);
    this.health[`image:${provider}`] = {
      ...this.health[`image:${provider}`],
      lastGenerationAt: at,
    };
    this.saveHealth();
  }

  imageLastGenerationAt(provider: "chatgpt" | "grok"): string | undefined {
    return this.health[`image:${provider}`]?.lastGenerationAt;
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

  public redactHealthMessage(message: string): string {
    this.reloadHealth();

    for (const credentialId of Object.keys(this.data)) {
      const credential = credentialAt(this.data, credentialId);

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

  public recordHealthFailure(
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

  public requestHealth(key: string): RequestHealthStatus | undefined {
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

  public async isCurrentHealthCredential(
    key: string,
    credential: ApiKeyCredential | OAuthCredential,
    version: number,
  ): Promise<boolean> {
    if (this.healthProbeVersions.get(key) !== version) return false;
    await this.reloadAsync();

    if (this.healthProbeVersions.get(key) !== version) return false;
    const current = credentialAt(this.data, key);

    if (current?.type !== credential.type || current.access !== credential.access) return false;

    return credential.type === "api-key"
      ? current.type === "api-key" && current.baseUrl === credential.baseUrl
      : current.type === "oauth" && current.refresh === credential.refresh;
  }

  async testHealth(provider: SubscriptionProviderId, instanceId?: string): Promise<void> {
    await this.reloadAsync();
    const key = credentialKey(provider, instanceId);
    const version = (this.healthProbeVersions.get(key) ?? 0) + 1;
    this.healthProbeVersions.set(key, version);
    const credential = credentialAt(this.data, key);

    if (!credential) {
      this.recordOAuthFailure(
        provider,
        this.store.current().loadError?.message ?? "No account is connected.",
        "request",
        instanceId,
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

        if (!(await this.isCurrentHealthCredential(key, credential, version))) return;

        if (!response.ok) {
          this.recordHealthFailure(
            key,
            `The provider rejected the API-key check (${response.status}).`,
            new Date().toISOString(),
            response.status === 401 || response.status === 403 ? "revoked" : "request",
          );
        } else {
          this.recordHealthSuccess(key, new Date().toISOString());
        }
      } catch {
        if (!(await this.isCurrentHealthCredential(key, credential, version))) return;
        this.recordHealthFailure(
          key,
          "The API-key check failed. Check the base URL and connection.",
          new Date().toISOString(),
          "request",
        );
      }

      return;
    }

    let testedCredential = credential;

    try {
      const refreshed =
        credential.expires > Date.now() ? credential : await runRefresh(provider, credential);

      if (!(await this.isCurrentHealthCredential(key, credential, version))) return;

      if (refreshed !== credential) {
        // Save under the store lock only while the tested credential is still stored,
        // so a logout or replacement that lands meanwhile is never undone.
        const saved = await this.updateCredentials((data) => {
          const latest = credentialAt(data, key);

          return latest?.type === "oauth" &&
            latest.access === credential.access &&
            latest.refresh === credential.refresh
            ? { ...data, [key]: refreshedCredential(latest, refreshed) }
            : data;
        });

        const stored = credentialAt(saved, key);

        if (stored?.type !== "oauth" || stored.access !== refreshed.access) return;
      }

      testedCredential = { type: "oauth", ...refreshed };
      const request = oauthHealthRequest(provider, refreshed);

      if (!request) throw new Error("This subscription does not expose a health endpoint.");

      const response = await fetch(request.url, {
        redirect: "error",
        headers: request.headers,
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });

      if (!(await this.isCurrentHealthCredential(key, testedCredential, version))) return;

      if (!response.ok) {
        throw new Error(`The provider rejected the health request (${response.status}).`);
      }

      this.recordHealthSuccess(key, new Date().toISOString());
      const checkedAt = new Date().toISOString();
      this.reloadHealth();
      this.health[key] = {
        ...this.health[key],
        oauthCheck: { status: "passed", checkedAt },
      };
      this.saveHealth();
    } catch (cause) {
      if (!(await this.isCurrentHealthCredential(key, testedCredential, version))) return;
      this.recordHealthFailure(
        key,
        cause instanceof Error ? cause.message : "The provider rejected the health request.",
        new Date().toISOString(),
        oauthFailureKind(cause),
      );
    }
  }

  /**
   * Start the post-login health check in the background. It keeps running when the
   * client that finished the login disconnects; `awaitHealthCheck` observes it.
   */
  public startHealthCheck(provider: SubscriptionProviderId, instanceId?: string): LoginPollStatus {
    if (!this.checkHealthOnConnect) return { status: "connected" };
    const key = credentialKey(provider, instanceId);
    this.reloadHealth();
    this.health[key] = {
      ...this.health[key],
      healthCheckStartedAt: new Date().toISOString(),
    };
    this.saveHealth();

    const check = this.testHealth(provider, instanceId)
      .finally(() => {
        if (this.healthChecks.get(key) !== check) return;
        this.reloadHealth();
        const current = this.health[key];

        if (current?.healthCheckStartedAt === undefined) return;
        const { healthCheckStartedAt: _startedAt, ...rest } = current;
        this.health[key] = rest;
        this.saveHealth();
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.healthChecks.get(key) === check) this.healthChecks.delete(key);
      });

    this.healthChecks.set(key, check);

    return { status: "connected", health: "checking" };
  }

  /** Resolves when the post-login health check for `provider` has recorded its result. */
  awaitHealthCheck(provider: SubscriptionProviderId, instanceId?: string): Promise<void> {
    return this.healthChecks.get(credentialKey(provider, instanceId)) ?? Promise.resolve();
  }

  public recordOAuthFailure(
    provider: SubscriptionProviderId,
    message: string,
    failureKind: "request" | "revoked" = "request",
    instanceId?: string,
  ): void {
    const key = credentialKey(provider, instanceId);
    const checkedAt = new Date().toISOString();
    this.reloadHealth();
    const { nextRetryAt: _nextRetryAt, ...previous } = this.health[key] ?? {};
    this.health[key] = {
      ...previous,
      lastFailedRequest: { at: checkedAt, message },
      failureKind,
      oauthCheck: { status: "failed", checkedAt },
    };
    this.saveHealth();
  }

  public clearImageHealth(provider: SubscriptionProviderId, instanceId?: string): void {
    if (instanceId !== undefined) return;

    if (provider === "openai-codex") delete this.health["image:chatgpt"];

    if (provider === "xai") delete this.health["image:grok"];
  }
}
