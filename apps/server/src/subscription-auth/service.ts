import { decodePendingLogins } from "./persistedSchemas.ts";
import * as Predicate from "effect/Predicate";
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import {
  type BotId,
  type ProviderInstanceId,
  type SubscriptionAuthStartInput,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  subscriptionCredentialStore,
  type SubscriptionAuthData,
  type SubscriptionCredentialStore,
} from "./credentialStore.ts";
import { completeAnthropicLogin, startAnthropicLogin } from "./providers/anthropic.ts";
import { pollCodexDeviceLogin, startCodexDeviceLogin } from "./providers/openaiCodex.ts";
import { pollKimiDeviceLogin, startKimiDeviceLogin } from "./providers/kimi.ts";
import { pollXAIDeviceLogin, startXAIDeviceLogin } from "./providers/xai.ts";
import type { ApiKeyCredential, OAuthCredential, OAuthCredentials } from "./types.ts";
import {
  decodeBaseUrl,
  OPENCODE_GO_AUTH_URL,
  SUBSCRIPTION_PROVIDER_IDS,
  type SubscriptionProviderId,
  type StartedLogin,
  type LoginPollStatus,
  type ProviderStatus,
  HEALTH_CHECK_STALE_MS,
  type RequestHealthStatus,
  type ImageRequestHealthStatus,
  lastGoodWarning,
  storeErrorStatus,
  type BoundLogin,
  defaultInstanceByProvider,
  credentialKey,
  credentialAt,
  PENDING_LOGIN_CAP,
} from "./serviceTypes.ts";
import { SubscriptionHealthService } from "./healthService.ts";
import { SubscriptionCredentialAccess } from "./credentialAccess.ts";

export class SubscriptionAuthService {
  private readonly credentialAccess: SubscriptionCredentialAccess;
  private readonly healthService: SubscriptionHealthService;
  private get health() {
    return this.healthService.health;
  }

  private readonly authPath: string;

  private readonly store: SubscriptionCredentialStore;

  private readonly pendingPath: string;

  private readonly pendingLogins = new Map<string, BoundLogin>();

  private readonly completedOAuthLogins = new Map<string, OAuthCredentials>();

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
    this.healthService = new SubscriptionHealthService(
      store,
      options.checkHealthOnConnect ?? false,
    );
    this.pendingPath = `${this.authPath}.pending`;

    this.credentialAccess = new SubscriptionCredentialAccess(store, this.healthService);
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
      const entries = decodePendingLogins(NodeFS.readFileSync(this.pendingPath, "utf-8"));

      for (const [loginId, pending] of entries.slice(-PENDING_LOGIN_CAP)) {
        // Logins for a retired provider (Cursor) can linger in the file.
        if (pending.provider === "cursor") continue;
        this.pendingLogins.set(loginId, pending);
      }
    } catch {
      this.pendingLogins.clear();
    }
  }

  private reloadHealth(): void {
    return this.healthService.reloadHealth();
  }

  private savePending(): void {
    this.healthService.writeSecureJson(this.pendingPath, [...this.pendingLogins.entries()]);
  }

  private saveHealth(): void {
    return this.healthService.saveHealth();
  }

  statuses(
    dependentBots: ReadonlyArray<{
      readonly id: BotId;
      readonly name: string;
      readonly provider: SubscriptionProviderId;
    }> = [],
    now = Date.now(),
    instanceId?: ProviderInstanceId,
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

      const key = credentialKey(provider, instanceId);
      const credential = credentialAt(data, key);
      const health = this.health[key];
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

      const accountLabel =
        credential?.type === "oauth"
          ? [credential.email, credential.accountId].find(
              (value): value is string => Predicate.isString(value) && value.trim().length > 0,
            )
          : undefined;

      return {
        provider,
        ...(instanceId ? { instanceId } : {}),
        connected: credential !== undefined,
        ...(accountLabel ? { accountLabel } : {}),
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
        dependentBots: dependentBots.flatMap((bot) =>
          bot.provider === provider ? [{ id: bot.id, name: bot.name }] : [],
        ),
        dependentRoutines: [],
      };
    });
  }

  accountStatus(
    provider: SubscriptionProviderId,
    instanceId: ProviderInstanceId,
    dependentBots: ReadonlyArray<{
      readonly id: BotId;
      readonly name: string;
      readonly provider: SubscriptionProviderId;
    }> = [],
  ): ProviderStatus {
    return this.statuses(dependentBots, Date.now(), instanceId).find(
      (status) => status.provider === provider,
    )!;
  }

  recordRequestSuccess(provider: SubscriptionProviderId, at = new Date().toISOString()): void {
    return this.healthService.recordRequestSuccess(provider, at);
  }

  recordAccountRequestSuccess(
    provider: SubscriptionProviderId,
    instanceId: string,
    at: string,
  ): void {
    return this.healthService.recordAccountRequestSuccess(provider, instanceId, at);
  }

  recordProviderInstanceSuccess(instanceId: string, at = new Date().toISOString()): void {
    return this.healthService.recordProviderInstanceSuccess(instanceId, at);
  }

  private recordHealthSuccess(key: string, at: string): void {
    return this.healthService.recordHealthSuccess(key, at);
  }

  recordRequestFailure(
    provider: SubscriptionProviderId,
    message: string,
    at = new Date().toISOString(),
    failureKind: "request" | "revoked" = "request",
  ): void {
    return this.healthService.recordRequestFailure(provider, message, at, failureKind);
  }

  recordAccountRequestFailure(
    provider: SubscriptionProviderId,
    instanceId: string,
    message: string,
    at: string,
  ): void {
    return this.healthService.recordAccountRequestFailure(provider, instanceId, message, at);
  }

  recordProviderInstanceFailure(
    instanceId: string,
    message: string,
    at = new Date().toISOString(),
    model?: string,
  ): void {
    return this.healthService.recordProviderInstanceFailure(instanceId, message, at, model);
  }

  recordMcpRequestSuccess(serverId: string, at = new Date().toISOString()): void {
    return this.healthService.recordMcpRequestSuccess(serverId, at);
  }

  recordMcpRequestFailure(serverId: string, message: string, at = new Date().toISOString()): void {
    return this.healthService.recordMcpRequestFailure(serverId, message, at);
  }

  recordImageRequestSuccess(provider: "chatgpt" | "grok", at = new Date().toISOString()): void {
    return this.healthService.recordImageRequestSuccess(provider, at);
  }

  recordImageCredentialProbeSuccess(
    provider: "chatgpt" | "grok",
    at = new Date().toISOString(),
  ): void {
    return this.healthService.recordImageCredentialProbeSuccess(provider, at);
  }

  recordImageCredentialProbeFailure(
    provider: "chatgpt" | "grok",
    message: string,
    at = new Date().toISOString(),
    failureKind: "request" | "revoked" = "request",
  ): void {
    return this.healthService.recordImageCredentialProbeFailure(provider, message, at, failureKind);
  }

  recordImageRequestFailure(
    provider: "chatgpt" | "grok",
    message: string,
    at = new Date().toISOString(),
    failureKind: "request" | "revoked" = "request",
  ): void {
    return this.healthService.recordImageRequestFailure(provider, message, at, failureKind);
  }

  /** A completed image generation, which also proves the provider healthy. */
  recordImageGenerationSuccess(provider: "chatgpt" | "grok", at = new Date().toISOString()): void {
    return this.healthService.recordImageGenerationSuccess(provider, at);
  }

  imageLastGenerationAt(provider: "chatgpt" | "grok"): string | undefined {
    return this.healthService.imageLastGenerationAt(provider);
  }

  /** Image-provider request health, keyed separately from the chat driver. */
  imageRequestHealth(provider: "chatgpt" | "grok"): ImageRequestHealthStatus | undefined {
    return this.healthService.imageRequestHealth(provider);
  }

  private recordHealthFailure(
    key: string,
    message: string,
    at: string,
    failureKind: "request" | "revoked",
    model?: string,
  ): void {
    return this.healthService.recordHealthFailure(key, message, at, failureKind, model);
  }

  providerInstanceHealth(
    instanceId: string,
  ): "healthy" | "failed" | "failed-first-request" | "recovered" | undefined {
    return this.healthService.providerInstanceHealth(instanceId);
  }

  providerInstanceRequestHealth(instanceId: string): RequestHealthStatus | undefined {
    return this.healthService.providerInstanceRequestHealth(instanceId);
  }

  mcpRequestHealth(serverId: string): RequestHealthStatus | undefined {
    return this.healthService.mcpRequestHealth(serverId);
  }

  private requestHealth(key: string): RequestHealthStatus | undefined {
    return this.healthService.requestHealth(key);
  }

  async testHealth(provider: SubscriptionProviderId, instanceId?: string): Promise<void> {
    return this.healthService.testHealth(provider, instanceId);
  }

  /**
   * Start the post-login health check in the background. It keeps running when the
   * client that finished the login disconnects; `awaitHealthCheck` observes it.
   */
  private startHealthCheck(provider: SubscriptionProviderId, instanceId?: string): LoginPollStatus {
    return this.healthService.startHealthCheck(provider, instanceId);
  }

  /** Resolves when the post-login health check for `provider` has recorded its result. */
  awaitHealthCheck(provider: SubscriptionProviderId, instanceId?: string): Promise<void> {
    return this.healthService.awaitHealthCheck(provider, instanceId);
  }

  private recordOAuthFailure(
    provider: SubscriptionProviderId,
    message: string,
    failureKind: "request" | "revoked" = "request",
    instanceId?: string,
  ): void {
    return this.healthService.recordOAuthFailure(provider, message, failureKind, instanceId);
  }

  isConnected(provider: SubscriptionProviderId, instanceId?: string): boolean {
    return credentialAt(this.data, credentialKey(provider, instanceId)) !== undefined;
  }

  hasOpenAICodexAccount(): boolean {
    const credential = this.data["openai-codex"];

    return (
      credential?.type === "oauth" &&
      Predicate.isString(credential.accountId) &&
      credential.accountId.length > 0
    );
  }

  async startLogin(
    provider: SubscriptionProviderId,
    options: Omit<SubscriptionAuthStartInput, "provider"> = {},
  ): Promise<StartedLogin> {
    await this.reloadAsync();
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
    const binding = options.instanceId ? { instanceId: options.instanceId } : {};
    let started: StartedLogin;

    if (authMode === "api-key") {
      this.pendingLogins.set(loginId, {
        provider,
        authMode,
        ...binding,
        ...(baseUrl ? { baseUrl } : {}),
      });
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
          this.pendingLogins.set(loginId, { provider, verifier, ...binding });
          started = { loginId, provider, url, completion: "paste" };
          break;
        }

        case "openai-codex": {
          const pending = await startCodexDeviceLogin();
          this.pendingLogins.set(loginId, { provider, pending, ...binding });
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
          this.pendingLogins.set(loginId, { provider, pending, ...binding });
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
          this.pendingLogins.set(loginId, { provider, pending, ...binding });
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
          this.pendingLogins.set(loginId, { provider, ...binding });
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
    const completed = this.completedOAuthLogins.get(loginId);

    if (login && completed)
      return this.foldPoll(loginId, login.provider, { status: "complete", credentials: completed });

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
          this.pendingLogins.set(loginId, {
            provider: "xai",
            pending: result.pending,
            ...(login.instanceId ? { instanceId: login.instanceId } : {}),
          });
          this.savePending();
        }

        return this.foldPoll(loginId, login.provider, result);
      }

      case "kimi-for-coding": {
        const result = await pollKimiDeviceLogin(login.pending);

        if (result.status === "pending") {
          this.pendingLogins.set(loginId, {
            provider: "kimi-for-coding",
            pending: result.pending,
            ...(login.instanceId ? { instanceId: login.instanceId } : {}),
          });
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
      case "complete": {
        await this.reloadAsync();
        const login = this.pendingLogins.get(loginId);

        if (!login) return { status: "failed", error: "Login cancelled. Start again." };

        if (!(await this.claimOAuthLogin(loginId, login, result.credentials)))
          return { status: "failed", error: "Login cancelled. Start again." };

        return this.startHealthCheck(provider, login.instanceId);
      }

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
      const key = credentialKey(login.provider, login.instanceId);
      // Claim the login inside the store update, so a cancel that lands while the
      // update waits for the file wins and nothing is saved.
      let claimed = false;
      await this.updateCredentials((data) => {
        this.reloadLocal();

        if (!this.pendingLogins.has(loginId)) return data;
        claimed = true;

        for (const [id, pending] of this.pendingLogins) {
          if (credentialKey(pending.provider, pending.instanceId) === key)
            this.pendingLogins.delete(id);
        }

        this.savePending();

        return {
          ...data,
          [key]: {
            type: "api-key",
            access: apiKey,
            connectionId: NodeCrypto.randomUUID(),
            ...(baseUrl ? { baseUrl } : {}),
          },
        };
      });

      if (!claimed) return { status: "failed", error: "Login cancelled. Start again." };
      this.reloadHealth();
      delete this.health[key];
      this.clearImageHealth(login.provider, login.instanceId);
      this.saveHealth();

      return this.startHealthCheck(login.provider, login.instanceId);
    }

    if (login.provider !== "anthropic") {
      return { status: "failed", error: "This login completes by polling, not with a code." };
    }

    try {
      const credentials =
        this.completedOAuthLogins.get(loginId) ??
        (await completeAnthropicLogin(code, login.verifier));

      if (!(await this.claimOAuthLogin(loginId, login, credentials)))
        return { status: "failed", error: "Login cancelled. Start again." };

      return this.startHealthCheck("anthropic", login.instanceId);
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
    this.completedOAuthLogins.delete(loginId);
    this.pendingLogins.delete(loginId);
    this.savePending();
  }

  async logout(provider: SubscriptionProviderId, instanceId?: string): Promise<void> {
    this.reloadLocal();
    const key = credentialKey(provider, instanceId);

    for (const [loginId, pending] of this.pendingLogins) {
      if (credentialKey(pending.provider, pending.instanceId) === key) {
        this.pendingLogins.delete(loginId);
        this.completedOAuthLogins.delete(loginId);
      }
    }

    this.savePending();
    await this.updateCredentials(({ [key]: _removed, ...rest }) => rest);
    this.reloadHealth();
    delete this.health[key];
    this.clearImageHealth(provider, instanceId);
    this.saveHealth();
  }

  private clearImageHealth(provider: SubscriptionProviderId, instanceId?: string): void {
    return this.healthService.clearImageHealth(provider, instanceId);
  }

  /** Sign out accounts that belonged to provider instances removed from settings. */
  async pruneDeletedInstanceCredentials(
    previous: Readonly<Record<string, { readonly driver: string }>>,
    current: Readonly<Record<string, { readonly driver: string }>>,
  ): Promise<void> {
    for (const [instanceId, instance] of Object.entries(previous)) {
      if (Object.hasOwn(current, instanceId)) continue;

      const provider = SUBSCRIPTION_PROVIDER_IDS.find(
        (candidate) => defaultInstanceByProvider[candidate] === instance.driver,
      );

      if (!provider || instanceId === defaultInstanceByProvider[provider]) continue;
      await this.logout(provider, instanceId);
    }
  }

  private async claimOAuthLogin(
    loginId: string,
    login: BoundLogin,
    credentials: OAuthCredentials,
  ): Promise<boolean> {
    const key = credentialKey(login.provider, login.instanceId);
    let claimed = false;
    let claimedPendingInode: bigint | undefined;
    this.completedOAuthLogins.set(loginId, credentials);

    try {
      await this.updateCredentials((data) => {
        this.reloadLocal();
        const current = this.pendingLogins.get(loginId);

        if (
          !current ||
          current.provider !== login.provider ||
          current.instanceId !== login.instanceId
        )
          return data;
        claimed = true;
        this.pendingLogins.delete(loginId);
        this.savePending();
        claimedPendingInode = NodeFS.statSync(this.pendingPath, { bigint: true }).ino;

        return {
          ...data,
          [key]: { ...credentials, type: "oauth", connectionId: NodeCrypto.randomUUID() },
        };
      });
    } catch (error) {
      this.reloadLocal();

      if (
        claimed &&
        NodeFS.existsSync(this.pendingPath) &&
        NodeFS.statSync(this.pendingPath, { bigint: true }).ino === claimedPendingInode
      ) {
        this.pendingLogins.set(loginId, login);
        this.savePending();
      }

      throw error;
    }

    this.completedOAuthLogins.delete(loginId);

    if (!claimed) return false;
    this.reloadHealth();
    delete this.health[key];
    this.clearImageHealth(login.provider, login.instanceId);
    this.saveHealth();

    return true;
  }

  /**
   * Ready-to-use access token for a provider, refreshing first when expired.
   * Concurrent callers share one refresh; a failed refresh clears nothing —
   * the user re-connects from Settings.
   */
  async getAccessToken(
    provider: SubscriptionProviderId,
    instanceId?: string,
  ): Promise<string | undefined> {
    return this.credentialAccess.getAccessToken(provider, instanceId);
  }

  async getPlanAccessToken(
    provider: SubscriptionProviderId,
    instanceId?: string,
  ): Promise<string | undefined> {
    return this.credentialAccess.getPlanAccessToken(provider, instanceId);
  }

  /**
   * The stored plan account and its access token. `accessToken` is null while the token is
   * temporarily unavailable, so callers still know which account is connected.
   */
  async getPlanAccess(
    provider: SubscriptionProviderId,
  ): Promise<{ readonly accessToken: string | null; readonly accountId: string } | undefined> {
    return this.credentialAccess.getPlanAccess(provider);
  }

  getApiKeyCredential(
    provider: SubscriptionProviderId,
    instanceId?: string,
  ): ApiKeyCredential | undefined {
    return this.credentialAccess.getApiKeyCredential(provider, instanceId);
  }

  getOAuthCredential(
    provider: SubscriptionProviderId,
    instanceId?: string,
  ): OAuthCredential | undefined {
    return this.credentialAccess.getOAuthCredential(provider, instanceId);
  }

  async getOpenAICodexAccess(
    instanceId?: string,
  ): Promise<{ readonly accessToken: string; readonly accountId: string } | undefined> {
    return this.credentialAccess.getOpenAICodexAccess(instanceId);
  }

  async getKimiForCodingAccess(
    instanceId?: string,
  ): Promise<
    | { readonly accessToken: string; readonly deviceId?: string; readonly baseUrl?: string }
    | undefined
  > {
    return this.credentialAccess.getKimiForCodingAccess(instanceId);
  }
}

export {
  anthropicApiBaseUrl,
  SUBSCRIPTION_PROVIDER_IDS,
  isSubscriptionProviderId,
  type SubscriptionProviderId,
  type LoginCompletion,
  type StartedLogin,
  type LoginPollStatus,
  type ProviderStatus,
  type RequestHealthStatus,
} from "./serviceTypes.ts";
