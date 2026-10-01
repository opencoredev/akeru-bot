import * as Predicate from "effect/Predicate";
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import { type SubscriptionAuthData, type SubscriptionCredentialStore } from "./credentialStore.ts";
import { isKimiCodingDeviceId } from "./providers/kimi.ts";
import type { ApiKeyCredential, OAuthCredential, OAuthCredentials } from "./types.ts";
import {
  type SubscriptionProviderId,
  oauthFailureKind,
  credentialKey,
  credentialAt,
  refreshedCredential,
  runRefresh,
} from "./serviceTypes.ts";
import { SubscriptionHealthService } from "./healthService.ts";

export class SubscriptionCredentialAccess {
  private readonly store: SubscriptionCredentialStore;
  private readonly healthService: SubscriptionHealthService;
  constructor(store: SubscriptionCredentialStore, healthService: SubscriptionHealthService) {
    this.store = store;
    this.healthService = healthService;
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

  private readonly refreshInFlight = new Map<string, Promise<string | undefined>>();

  /**
   * Ready-to-use access token for a provider, refreshing first when expired.
   * Concurrent callers share one refresh; a failed refresh clears nothing —
   * the user re-connects from Settings.
   */
  async getAccessToken(
    provider: SubscriptionProviderId,
    instanceId?: string,
  ): Promise<string | undefined> {
    const key = credentialKey(provider, instanceId);
    const credential = credentialAt(this.data, key);

    if (!credential) return undefined;

    if (credential.type === "api-key") return credential.access;

    if (Date.now() < credential.expires) {
      return credential.access;
    }

    const inFlight = this.refreshInFlight.get(key);

    if (inFlight) return inFlight;

    const refresh = this.refreshCredential(provider, credential, instanceId).finally(() => {
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
    const key = credentialKey(provider);
    await this.reloadAsync();
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

    const accessToken = await this.getPlanAccessToken(provider).catch(() => undefined);
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
  ): ApiKeyCredential | undefined {
    const credential = credentialAt(this.data, credentialKey(provider, instanceId));

    return credential?.type === "api-key" ? credential : undefined;
  }

  getOAuthCredential(
    provider: SubscriptionProviderId,
    instanceId?: string,
  ): OAuthCredential | undefined {
    const credential = credentialAt(this.data, credentialKey(provider, instanceId));

    return credential?.type === "oauth" ? credential : undefined;
  }

  async getOpenAICodexAccess(
    instanceId?: string,
  ): Promise<{ readonly accessToken: string; readonly accountId: string } | undefined> {
    await this.reloadAsync();
    const accessToken = await this.getAccessToken("openai-codex", instanceId);
    const credential = credentialAt(this.data, credentialKey("openai-codex", instanceId));
    const accountId = credential?.type === "oauth" ? credential.accountId : undefined;

    return accessToken && Predicate.isString(accountId) && accountId.length > 0
      ? { accessToken, accountId }
      : undefined;
  }

  async getKimiForCodingAccess(
    instanceId?: string,
  ): Promise<
    | { readonly accessToken: string; readonly deviceId?: string; readonly baseUrl?: string }
    | undefined
  > {
    await this.reloadAsync();
    const accessToken = await this.getAccessToken("kimi-for-coding", instanceId);
    const credential = credentialAt(this.data, credentialKey("kimi-for-coding", instanceId));

    if (credential?.type === "api-key" && accessToken) {
      return { accessToken, ...(credential.baseUrl ? { baseUrl: credential.baseUrl } : {}) };
    }

    const deviceId = credential?.type === "oauth" ? credential.deviceId : undefined;

    return accessToken && isKimiCodingDeviceId(deviceId) ? { accessToken, deviceId } : undefined;
  }

  private async refreshCredential(
    provider: SubscriptionProviderId,
    credential: OAuthCredential,
    instanceId?: string,
  ): Promise<string | undefined> {
    const key = credentialKey(provider, instanceId);

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
      this.healthService.recordOAuthFailure(
        provider,
        cause instanceof Error ? cause.message : "The provider rejected the token refresh.",
        oauthFailureKind(cause),
        instanceId,
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
