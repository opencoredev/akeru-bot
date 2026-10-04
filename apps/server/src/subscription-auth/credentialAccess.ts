import { SubscriptionAccountState } from "./accountState.ts";
import * as Predicate from "effect/Predicate";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import type * as Clock from "effect/Clock";
import { type SubscriptionAuthData, type SubscriptionCredentialStore } from "./credentialStore.ts";
import { isKimiCodingDeviceId } from "./providers/kimi.ts";
import type { ApiKeyCredential, OAuthCredential, OAuthCredentials } from "./types.ts";
import {
  type SubscriptionProviderId,
  oauthFailureKind,
  credentialKey,
  accountScope,
  accountIdForKey,
  DEFAULT_ACCOUNT_ID,
  isDefaultScope,
  credentialAt,
  refreshedCredential,
  runRefresh,
} from "./serviceTypes.ts";
import { SubscriptionHealthService } from "./healthService.ts";

export class SubscriptionCredentialAccess {
  private readonly accounts: SubscriptionAccountState;
  private readonly clock: Clock.Clock;
  private readonly reload: () => Effect.Effect<void>;
  private readonly store: SubscriptionCredentialStore;
  private readonly healthService: SubscriptionHealthService;
  constructor(
    store: SubscriptionCredentialStore,
    healthService: SubscriptionHealthService,
    accounts: SubscriptionAccountState,
    clock: Clock.Clock,
    reload: () => Effect.Effect<void>,
  ) {
    this.accounts = accounts;
    this.clock = clock;
    this.reload = reload;
    this.store = store;
    this.healthService = healthService;
  }
  private get data() {
    return this.store.current().data;
  }
  private reloadAsync() {
    return Effect.runPromise(this.reload());
  }
  private updateCredentials(update: (data: SubscriptionAuthData) => SubscriptionAuthData) {
    return Effect.runPromise(this.store.update(update));
  }

  private readonly refreshInFlight = new Map<string, Promise<string | undefined>>();

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
    const key = this.accounts.servingKey(provider, instanceId, threadId);
    const credential = credentialAt(this.data, key);

    if (!credential) return undefined;

    if (credential.type === "api-key") return credential.access;

    if (this.clock.currentTimeMillisUnsafe() < credential.expires) {
      return credential.access;
    }

    const inFlight = this.refreshInFlight.get(key);

    if (inFlight) return inFlight;

    const refresh = this.refreshCredential(provider, credential, key).finally(() => {
      this.refreshInFlight.delete(key);
    });

    this.refreshInFlight.set(key, refresh);

    return refresh;
  }

  async getPlanAccessToken(
    provider: SubscriptionProviderId,
    instanceId?: string,
  ): Promise<string | undefined> {
    const apiKey = this.getApiKeyCredential(provider, instanceId);

    if (apiKey && (provider !== "opencode-go" || apiKey.baseUrl)) return undefined;

    return this.getAccessToken(provider, instanceId);
  }

  /**
   * The stored plan account and its access token. `accessToken` is null while the token is
   * temporarily unavailable, so callers still know which account is connected.
   */
  async getPlanAccess(
    provider: SubscriptionProviderId,
  ): Promise<{ readonly accessToken: string | null; readonly accountId: string } | undefined> {
    await this.reloadAsync();

    const key = this.accounts.liveKey(provider);

    const scope = accountScope(accountIdForKey(provider, key) ?? DEFAULT_ACCOUNT_ID);
    const credential = credentialAt(this.data, key);

    if (
      !credential ||
      (credential.type === "api-key" && (provider !== "opencode-go" || credential.baseUrl))
    )
      return undefined;

    if (!Predicate.isString(credential.connectionId) || !credential.connectionId) {
      await this.updateCredentials((data) => {
        const current = credentialAt(data, key);

        if (!current || (Predicate.isString(current.connectionId) && current.connectionId))
          return data;

        return { ...data, [key]: { ...current, connectionId: NodeCrypto.randomUUID() } };
      });
    }

    const accessToken = await this.getPlanAccessToken(provider, scope).catch(() => undefined);
    await this.reloadAsync();
    const current = credentialAt(this.data, key);

    if (!current) return undefined;

    const accountId =
      current.type === "oauth" && Predicate.isString(current.accountId) && current.accountId
        ? current.accountId
        : current.connectionId;

    if (!Predicate.isString(accountId) || !accountId)
      throw new Error("Plan account identity is unavailable.");

    return { accessToken: accessToken ? current.access : null, accountId };
  }

  getApiKeyCredential(
    provider: SubscriptionProviderId,
    instanceId?: string,
    threadId?: string,
  ): ApiKeyCredential | undefined {
    const credential = credentialAt(
      this.data,
      this.accounts.servingKey(provider, instanceId, threadId),
    );

    return credential?.type === "api-key" ? credential : undefined;
  }

  getOAuthCredential(
    provider: SubscriptionProviderId,
    instanceId?: string,
    threadId?: string,
  ): OAuthCredential | undefined {
    const credential = credentialAt(
      this.data,
      this.accounts.servingKey(provider, instanceId, threadId),
    );

    return credential?.type === "oauth" ? credential : undefined;
  }

  async getOpenAICodexAccess(
    instanceId?: string,
    threadId?: string,
  ): Promise<{ readonly accessToken: string; readonly accountId: string } | undefined> {
    await this.reloadAsync();
    const scope = this.pinnedScope("openai-codex", instanceId, threadId);
    const accessToken = await this.getAccessToken("openai-codex", scope);
    const credential = credentialAt(this.data, credentialKey("openai-codex", scope));
    const accountId = credential?.type === "oauth" ? credential.accountId : undefined;

    return accessToken && Predicate.isString(accountId) && accountId.length > 0
      ? { accessToken, accountId }
      : undefined;
  }

  async getKimiForCodingAccess(
    instanceId?: string,
    threadId?: string,
  ): Promise<
    | { readonly accessToken: string; readonly deviceId?: string; readonly baseUrl?: string }
    | undefined
  > {
    await this.reloadAsync();
    const scope = this.pinnedScope("kimi-for-coding", instanceId, threadId);
    const accessToken = await this.getAccessToken("kimi-for-coding", scope);
    const credential = credentialAt(this.data, credentialKey("kimi-for-coding", scope));

    if (credential?.type === "api-key" && accessToken) {
      return { accessToken, ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}) };
    }

    const deviceId = credential?.type === "oauth" ? credential.deviceId : undefined;

    return accessToken && isKimiCodingDeviceId(deviceId) ? { accessToken, deviceId } : undefined;
  }

  /** One account for a read that touches the credential twice, so both reads agree. */
  private pinnedScope(
    provider: SubscriptionProviderId,
    instanceId?: string,
    threadId?: string,
  ): string | undefined {
    if (!isDefaultScope(provider, instanceId)) return instanceId;
    const key = this.accounts.servingKey(provider, instanceId, threadId);

    return accountScope(accountIdForKey(provider, key) ?? DEFAULT_ACCOUNT_ID);
  }

  private async refreshCredential(
    provider: SubscriptionProviderId,
    credential: OAuthCredential,
    key: string,
  ): Promise<string | undefined> {
    try {
      const refreshed = await this.runRefresh(provider, credential);
      await this.reloadAsync();
      // Another service may have refreshed the same login meanwhile. Providers
      // that do not rotate refresh tokens leave `refresh` unchanged, so only the
      // access token shows whether the stored credential is still the one refreshed.
      const current = credentialAt(this.data, key);

      if (
        current?.type !== "oauth" ||
        current.access !== credential.access ||
        current.refresh !== credential.refresh
      ) {
        return current?.access;
      }

      const saved = await this.updateCredentials((data) => {
        const latest = credentialAt(data, key);

        return latest?.type === "oauth" &&
          latest.access === credential.access &&
          latest.refresh === credential.refresh
          ? { ...data, [key]: refreshedCredential(latest, refreshed) }
          : data;
      });

      return credentialAt(saved, key)?.access;
    } catch (cause) {
      // Refresh failed — the user must re-connect. Keep the stored credential
      // so status still shows which account was linked.
      this.healthService.recordOAuthFailureForKey(
        key,
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
    return runRefresh(provider, credential);
  }
}
