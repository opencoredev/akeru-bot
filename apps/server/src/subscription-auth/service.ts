import { startSubscriptionLogin } from "./loginStart.ts";
import { SubscriptionAccountState } from "./accountState.ts";
import * as DateTime from "effect/DateTime";
import { decodePendingLogins } from "./persistedSchemas.ts";
import * as Predicate from "effect/Predicate";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import {
  type BotId,
  type ProviderInstanceId,
  type SubscriptionAuthStartInput,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  subscriptionCredentialStore,
  type SubscriptionAuthData,
  type SubscriptionCredentialStore,
} from "./credentialStore.ts";
import { completeAnthropicLogin } from "./providers/anthropic.ts";
import { pollCodexDeviceLogin } from "./providers/openaiCodex.ts";
import { pollKimiDeviceLogin } from "./providers/kimi.ts";
import { pollXAIDeviceLogin } from "./providers/xai.ts";
import type { ApiKeyCredential, OAuthCredential, OAuthCredentials } from "./types.ts";
import {
  SUBSCRIPTION_PROVIDER_IDS,
  type SubscriptionProviderId,
  type StartedLogin,
  type LoginPollStatus,
  type ProviderStatus,
  type RequestHealthStatus,
  type ImageRequestHealthStatus,
  type BoundLogin,
  defaultInstanceByProvider,
  credentialKey,
  accountScope,
  accountIdForKey,
  DEFAULT_ACCOUNT_ID,
  isDefaultScope,
  credentialAt,
  PENDING_LOGIN_CAP,
} from "./serviceTypes.ts";
import { SubscriptionHealthService } from "./healthService.ts";
import { SubscriptionCredentialAccess } from "./credentialAccess.ts";
import { providerStatuses, linkedAccountStatuses } from "./providerStatuses.ts";

export class SubscriptionAuthService {
  private readonly accounts: SubscriptionAccountState;
  private readonly clock: Clock.Clock;
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
    clock: Clock.Clock,
    path: Path.Path,
    options: { readonly checkHealthOnConnect?: boolean },
  ) {
    this.clock = clock;
    this.store = store;
    this.authPath = store.path;
    this.healthService = new SubscriptionHealthService(
      store,
      clock,
      path,
      options.checkHealthOnConnect ?? false,
      () => this.reload(),
    );
    this.accounts = new SubscriptionAccountState(store, this.healthService, clock, () =>
      this.reload(),
    );
    this.pendingPath = `${this.authPath}.pending`;

    this.credentialAccess = new SubscriptionCredentialAccess(
      store,
      this.healthService,
      this.accounts,
      clock,
      () => this.reload(),
    );
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

      const clock = yield* Clock.Clock;
      const path = yield* Path.Path;

      return new SubscriptionAuthService(store, clock, path, options);
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
    this.accounts.reloadAccountOrder();

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
    now = this.clock.currentTimeMillisUnsafe(),
    instanceId?: ProviderInstanceId,
  ): ProviderStatus[] {
    this.accounts.refreshAccountState();

    return providerStatuses(
      this.store.current(),
      this.health,
      dependentBots,
      now,
      instanceId,
      (provider) =>
        isDefaultScope(provider, instanceId)
          ? this.accounts.activeAccountKey(provider, now)
          : credentialKey(provider, instanceId),
    );
  }

  linkedAccountIds(provider: SubscriptionProviderId): string[] {
    return this.accounts.linkedAccountIds(provider);
  }
  setAccountOrder(
    provider: SubscriptionProviderId,
    accountIds: ReadonlyArray<string>,
  ): Promise<void> {
    return this.accounts.setAccountOrder(provider, accountIds);
  }
  linkedAccountStatuses(now = this.clock.currentTimeMillisUnsafe()): ProviderStatus[] {
    this.accounts.refreshAccountState();

    return linkedAccountStatuses(this.store.current(), this.health, this.accounts, now);
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
    return this.statuses(dependentBots, this.clock.currentTimeMillisUnsafe(), instanceId).find(
      (status) => status.provider === provider,
    )!;
  }

  recordRequestSuccess(
    provider: SubscriptionProviderId,
    at = DateTime.formatIso(DateTime.makeUnsafe(this.clock.currentTimeMillisUnsafe())),
    threadId?: string,
  ): void {
    this.healthService.recordHealthSuccess(
      this.accounts.outcomeKey(provider, undefined, threadId),
      at,
    );
  }

  recordAccountRequestSuccess(
    provider: SubscriptionProviderId,
    instanceId: string,
    at: string,
    threadId?: string,
  ): void {
    this.healthService.recordHealthSuccess(
      this.accounts.outcomeKey(provider, instanceId, threadId),
      at,
    );
  }

  recordProviderInstanceSuccess(instanceId: string, at?: string): void {
    return this.healthService.recordProviderInstanceSuccess(instanceId, at);
  }

  recordRequestFailure(
    provider: SubscriptionProviderId,
    message: string,
    at = DateTime.formatIso(DateTime.makeUnsafe(this.clock.currentTimeMillisUnsafe())),
    failureKind: "request" | "revoked" = "request",
    threadId?: string,
  ): void {
    this.healthService.recordAccountFailure(
      this.accounts.outcomeKey(provider, undefined, threadId),
      message,
      at,
      failureKind,
    );
  }

  recordAccountRequestFailure(
    provider: SubscriptionProviderId,
    instanceId: string,
    message: string,
    at: string,
    threadId?: string,
  ): void {
    this.healthService.recordAccountFailure(
      this.accounts.outcomeKey(provider, instanceId, threadId),
      message,
      at,
      "request",
    );
  }

  recordProviderInstanceFailure(
    instanceId: string,
    message: string,
    at?: string,
    model?: string,
  ): void {
    return this.healthService.recordProviderInstanceFailure(instanceId, message, at, model);
  }

  recordMcpRequestSuccess(serverId: string, at?: string): void {
    return this.healthService.recordMcpRequestSuccess(serverId, at);
  }

  recordMcpRequestFailure(serverId: string, message: string, at?: string): void {
    return this.healthService.recordMcpRequestFailure(serverId, message, at);
  }

  recordImageRequestSuccess(provider: "chatgpt" | "grok", at?: string): void {
    return this.healthService.recordImageRequestSuccess(provider, at);
  }

  recordImageCredentialProbeSuccess(provider: "chatgpt" | "grok", at?: string): void {
    return this.healthService.recordImageCredentialProbeSuccess(provider, at);
  }

  recordImageCredentialProbeFailure(
    provider: "chatgpt" | "grok",
    message: string,
    at?: string,
    failureKind: "request" | "revoked" = "request",
  ): void {
    return this.healthService.recordImageCredentialProbeFailure(provider, message, at, failureKind);
  }

  recordImageRequestFailure(
    provider: "chatgpt" | "grok",
    message: string,
    at?: string,
    failureKind: "request" | "revoked" = "request",
  ): void {
    return this.healthService.recordImageRequestFailure(provider, message, at, failureKind);
  }

  /** A completed image generation, which also proves the provider healthy. */
  recordImageGenerationSuccess(provider: "chatgpt" | "grok", at?: string): void {
    return this.healthService.recordImageGenerationSuccess(provider, at);
  }

  imageLastGenerationAt(provider: "chatgpt" | "grok"): string | undefined {
    return this.healthService.imageLastGenerationAt(provider);
  }

  /** Image-provider request health, keyed separately from the chat driver. */
  imageRequestHealth(provider: "chatgpt" | "grok"): ImageRequestHealthStatus | undefined {
    return this.healthService.imageRequestHealth(provider);
  }

  providerInstanceHealth(
    instanceId: string,
  ): "healthy" | "failed" | "failed-first-request" | "recovered" | undefined {
    return this.healthService.providerInstanceHealth(instanceId);
  }

  providerInstanceRequestHealth(instanceId: string): RequestHealthStatus | undefined {
    return this.accounts.providerInstanceRequestHealth(instanceId);
  }

  mcpRequestHealth(serverId: string): RequestHealthStatus | undefined {
    return this.healthService.mcpRequestHealth(serverId);
  }

  async testHealth(provider: SubscriptionProviderId, instanceId?: string): Promise<void> {
    const scope = isDefaultScope(provider, instanceId)
      ? accountScope(
          accountIdForKey(provider, this.accounts.liveKey(provider, instanceId)) ??
            DEFAULT_ACCOUNT_ID,
        )
      : instanceId;

    return this.healthService.testHealth(provider, scope);
  }

  /**
   * Start the post-login health check in the background. It keeps running when the
   * client that finished the login disconnects; `awaitHealthCheck` observes it.
   */
  private startHealthCheck(provider: SubscriptionProviderId, instanceId?: string): LoginPollStatus {
    this.accounts.rememberAccountOrder(provider);

    return this.healthService.startHealthCheck(provider, instanceId);
  }

  /** Resolves when the post-login health check for `provider` has recorded its result. */
  awaitHealthCheck(provider: SubscriptionProviderId, instanceId?: string): Promise<void> {
    return this.healthService.awaitHealthCheck(provider, instanceId);
  }

  isConnected(provider: SubscriptionProviderId, instanceId?: string): boolean {
    return credentialAt(this.data, this.accounts.liveKey(provider, instanceId)) !== undefined;
  }

  hasOpenAICodexAccount(): boolean {
    const credential = credentialAt(this.data, this.accounts.liveKey("openai-codex"));

    return (
      credential?.type === "oauth" &&
      Predicate.isString(credential.accountId) &&
      credential.accountId.length > 0
    );
  }

  startLogin(
    provider: SubscriptionProviderId,
    options: Omit<SubscriptionAuthStartInput, "provider"> = {},
  ): Promise<StartedLogin> {
    return startSubscriptionLogin(
      {
        reloadAsync: () => this.reloadAsync(),
        loginScope: (provider, options) => this.loginScope(provider, options),
        pendingLogins: this.pendingLogins,
        savePending: () => this.savePending(),
      },
      provider,
      options,
    );
  }

  private loginScope(
    provider: SubscriptionProviderId,
    options: Omit<SubscriptionAuthStartInput, "provider">,
  ): string {
    if (options.accountId) return accountScope(options.accountId);

    if (!isDefaultScope(provider, options.instanceId)) return options.instanceId!;
    const linked = this.linkedAccountIds(provider);

    if (options.addAccount && linked.length > 0) {
      return accountScope(`acct-${NodeCrypto.randomBytes(6).toString("hex")}`);
    }

    const active = accountIdForKey(provider, this.accounts.activeAccountKey(provider));

    return accountScope(active ?? DEFAULT_ACCOUNT_ID);
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

    if (this.accounts.lastServedKey.get(provider) === key)
      this.accounts.lastServedKey.delete(provider);
    this.accounts.rememberAccountOrder(provider);
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
    threadId?: string,
  ): Promise<string | undefined> {
    return this.credentialAccess.getAccessToken(provider, instanceId, threadId);
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
    threadId?: string,
  ): ApiKeyCredential | undefined {
    return this.credentialAccess.getApiKeyCredential(provider, instanceId, threadId);
  }

  getOAuthCredential(
    provider: SubscriptionProviderId,
    instanceId?: string,
    threadId?: string,
  ): OAuthCredential | undefined {
    return this.credentialAccess.getOAuthCredential(provider, instanceId, threadId);
  }

  async getOpenAICodexAccess(
    instanceId?: string,
    threadId?: string,
  ): Promise<{ readonly accessToken: string; readonly accountId: string } | undefined> {
    return this.credentialAccess.getOpenAICodexAccess(instanceId, threadId);
  }

  async getKimiForCodingAccess(
    instanceId?: string,
    threadId?: string,
  ): Promise<
    | { readonly accessToken: string; readonly deviceId?: string; readonly baseUrl?: string }
    | undefined
  > {
    return this.credentialAccess.getKimiForCodingAccess(instanceId, threadId);
  }
}

export {
  anthropicApiBaseUrl,
  accountScope,
  SUBSCRIPTION_PROVIDER_IDS,
  isSubscriptionProviderId,
  type SubscriptionProviderId,
  type LoginCompletion,
  type StartedLogin,
  type LoginPollStatus,
  type ProviderStatus,
  type RequestHealthStatus,
} from "./serviceTypes.ts";

export { isAccountLimitMessage, limitRetryAt } from "./accountLimits.ts";
