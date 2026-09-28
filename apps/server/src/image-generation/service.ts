// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off
/**
 * Image generation provider service.
 *
 * Two rows: ChatGPT (backed by the `openai-codex` subscription credential) and
 * Grok (backed by `xai`). Credentials never leave SubscriptionAuthService; this
 * module only reads access tokens through `getAccessToken`. Health is recorded
 * under `image:<provider>` keys so an image failure cannot masquerade as a
 * chat-driver failure or vice versa.
 *
 * The health test performs one real, cheap request against the provider's API.
 * It is the only thing that can move a provider to `healthy` — a connected
 * credential reports `detected` until a request succeeds. There is no
 * generation producer yet (milestone decision D5), so `lastGenerationAt` is
 * always absent and surfaces as "never generated" to clients.
 */
import {
  type ImageGenerationSettings,
  ImageGenerationSettingsPatch,
  type ImageProviderId,
  ImageProviderStatus,
  type ServerSettings,
  type ServerSettingsPatch,
  type SubscriptionProviderStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  SubscriptionAuthService,
  type SubscriptionProviderId,
} from "../subscription-auth/service.ts";

const IMAGE_PROVIDER_META: Readonly<
  Record<
    ImageProviderId,
    { label: string; subscription: SubscriptionProviderId; modelsUrl: string }
  >
> = {
  chatgpt: {
    label: "ChatGPT",
    subscription: "openai-codex",
    modelsUrl: "https://api.openai.com/v1/models",
  },
  grok: {
    label: "Grok",
    subscription: "xai",
    modelsUrl: "https://api.x.ai/v1/models",
  },
};

const IMAGE_PROVIDER_IDS: ReadonlyArray<ImageProviderId> = ["chatgpt", "grok"];
const HEALTH_TEST_TIMEOUT_MS = 15_000;

function oauthFailureKind(cause: unknown): "request" | "revoked" {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /\b(?:invalid_grant|revoked|unauthori[sz]ed|401|403)\b/i.test(message)
    ? "revoked"
    : "request";
}

type ImageRequestHealth = ReturnType<SubscriptionAuthService["imageRequestHealth"]>;

function subscriptionStatusFor(
  statuses: ReadonlyArray<SubscriptionProviderStatus>,
  provider: ImageProviderId,
): SubscriptionProviderStatus | undefined {
  return statuses.find((status) => status.provider === IMAGE_PROVIDER_META[provider].subscription);
}

function rowHealth(input: {
  connected: boolean;
  enabled: boolean;
  requestHealth: ImageRequestHealth;
}): ImageProviderStatus["health"] {
  if (!input.connected) return "missing";
  if (!input.enabled) return "disabled";
  return input.requestHealth?.health ?? "detected";
}

/**
 * Build the two provider rows from subscription status, request health, and
 * the imageGeneration settings block. `lastGenerationAt` stays undefined: the
 * generation tool ships in milestone 7 and nothing records it yet.
 */
export function imageProviderStatuses(input: {
  readonly settings: ImageGenerationSettings;
  readonly subscriptionStatuses: ReadonlyArray<SubscriptionProviderStatus>;
  readonly requestHealth: (provider: ImageProviderId) => ImageRequestHealth;
}): ImageProviderStatus[] {
  return IMAGE_PROVIDER_IDS.map((provider) => {
    const meta = IMAGE_PROVIDER_META[provider];
    const subscription = subscriptionStatusFor(input.subscriptionStatuses, provider);
    const connected = subscription?.connected ?? false;
    const enabled =
      provider === "chatgpt" ? input.settings.chatgptEnabled : input.settings.grokEnabled;
    const requestHealth = input.requestHealth(provider);
    const health = rowHealth({ connected, enabled, requestHealth });
    const repairAction = !connected
      ? `Connect ${meta.label} subscription`
      : health === "revoked" || health === "expired"
        ? `Reconnect ${meta.label} subscription`
        : health === "failed" || health === "failed-first-request"
          ? "Run health test"
          : undefined;
    return {
      provider,
      label: meta.label,
      connected,
      enabled,
      health,
      operations: ["generate"],
      ...(requestHealth?.lastFailedRequest ? { lastFailure: requestHealth.lastFailedRequest } : {}),
      ...(repairAction ? { repairAction } : {}),
      healthTest:
        requestHealth?.lastFailedRequest &&
        (!requestHealth.lastSuccessfulRequestAt ||
          requestHealth.lastFailedRequest.at >= requestHealth.lastSuccessfulRequestAt)
          ? { status: "failed" as const, checkedAt: requestHealth.lastFailedRequest.at }
          : requestHealth?.lastSuccessfulRequestAt
            ? { status: "passed" as const, checkedAt: requestHealth.lastSuccessfulRequestAt }
            : { status: "not-run" as const },
    };
  });
}

/**
 * Normalize an imageGeneration patch against the merged result. A provider
 * that is not enabled can never be the default, and the fallback order only
 * keeps enabled providers. Both rules are enforced server-side so clients
 * cannot persist an incoherent configuration.
 */
export function normalizeImageGenerationPatch(
  current: ImageGenerationSettings,
  patch: ImageGenerationSettingsPatch,
): ImageGenerationSettingsPatch {
  const merged: ImageGenerationSettings = {
    chatgptEnabled: patch.chatgptEnabled ?? current.chatgptEnabled,
    grokEnabled: patch.grokEnabled ?? current.grokEnabled,
    defaultProvider:
      patch.defaultProvider === undefined ? current.defaultProvider : patch.defaultProvider,
    fallbackOrder: patch.fallbackOrder ?? current.fallbackOrder,
  };
  const enabled = (id: ImageProviderId) =>
    id === "chatgpt" ? merged.chatgptEnabled : merged.grokEnabled;

  // Filter the merged order on every enable/disable/default change, not only
  // when the caller supplies an order — a persisted order can otherwise keep
  // selecting a provider the patch just disabled.
  const fallbackOrder = merged.fallbackOrder.filter(enabled);
  for (const provider of IMAGE_PROVIDER_IDS) {
    if (enabled(provider) && !fallbackOrder.includes(provider)) fallbackOrder.push(provider);
  }
  const normalized: ImageGenerationSettings = {
    chatgptEnabled: merged.chatgptEnabled,
    grokEnabled: merged.grokEnabled,
    defaultProvider:
      merged.defaultProvider !== null && enabled(merged.defaultProvider)
        ? merged.defaultProvider
        : // An enabled provider must always be selectable; with none enabled
          // the default stays null and the fallback order is empty.
          (fallbackOrder[0] ?? null),
    fallbackOrder,
  };

  // Emit only the fields the patch touched or that normalization had to fix,
  // so a bare enable/disable does not rewrite unrelated fields.
  return {
    ...(patch.chatgptEnabled !== undefined ? { chatgptEnabled: patch.chatgptEnabled } : {}),
    ...(patch.grokEnabled !== undefined ? { grokEnabled: patch.grokEnabled } : {}),
    ...(patch.defaultProvider !== undefined ? { defaultProvider: patch.defaultProvider } : {}),
    ...(patch.fallbackOrder !== undefined ? { fallbackOrder: patch.fallbackOrder } : {}),
    ...(normalized.fallbackOrder.join() !== merged.fallbackOrder.join()
      ? { fallbackOrder: normalized.fallbackOrder }
      : {}),
    ...(normalized.defaultProvider !== merged.defaultProvider
      ? { defaultProvider: normalized.defaultProvider }
      : {}),
  } satisfies ImageGenerationSettingsPatch;
}

/** Wraps an `imageGeneration` patch in a ServerSettingsPatch. */
export function imageGenerationSettingsPatch(
  patch: ImageGenerationSettingsPatch,
): ServerSettingsPatch {
  return { imageGeneration: patch };
}

/**
 * One real request per provider. ChatGPT goes through the OAuth access token
 * (`openai-codex` credential); Grok uses the `xai` token, which may be OAuth
 * or API key — `getAccessToken` handles both. A non-OK response or network
 * error records a failure and never reports healthy.
 */
export async function runImageProviderHealthTest(input: {
  readonly provider: ImageProviderId;
  readonly subscriptionAuth: SubscriptionAuthService;
  readonly fetchFn?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}): Promise<void> {
  const { provider, subscriptionAuth } = input;
  const meta = IMAGE_PROVIDER_META[provider];
  const fetchFn = input.fetchFn ?? fetch;

  // Token acquisition stays inside the guarded path: a rejected OAuth refresh
  // must still land as a durable, redacted image-provider failure instead of
  // escaping as a bare RPC error.
  const connected = subscriptionAuth.isConnected(meta.subscription);
  let token: string | undefined;
  try {
    token = await subscriptionAuth.getAccessToken(meta.subscription);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    subscriptionAuth.recordImageRequestFailure(
      provider,
      `The ${meta.label} subscription could not be used: ${message}`,
      undefined,
      oauthFailureKind(cause),
    );
    return;
  }
  if (!token) {
    // getAccessToken swallows a rejected refresh and returns undefined after
    // recording the provider-level OAuth failure. Mirror the honest state onto
    // the image row instead of claiming no credential exists.
    const subscriptionStatus = subscriptionAuth
      .statuses()
      .find((status) => status.provider === meta.subscription);
    if (connected && subscriptionStatus?.lastFailedRequest) {
      const revoked = subscriptionStatus.health === "revoked";
      subscriptionAuth.recordImageRequestFailure(
        provider,
        revoked
          ? `The ${meta.label} subscription needs to be reconnected: ${subscriptionStatus.lastFailedRequest.message}`
          : `The ${meta.label} subscription request failed: ${subscriptionStatus.lastFailedRequest.message}`,
        undefined,
        revoked ? "revoked" : "request",
      );
      return;
    }
    subscriptionAuth.recordImageRequestFailure(
      provider,
      `No ${meta.label} subscription is connected.`,
      undefined,
      "revoked",
    );
    return;
  }

  try {
    const response = await fetchFn(meta.modelsUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(HEALTH_TEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "akeru-bot/0.0.37",
      },
    });
    if (!response.ok) {
      subscriptionAuth.recordImageRequestFailure(
        provider,
        `${meta.label} image health check was rejected (${response.status}).`,
        undefined,
        response.status === 401 || response.status === 403 ? "revoked" : "request",
      );
      return;
    }
    subscriptionAuth.recordImageRequestSuccess(provider);
  } catch (cause) {
    subscriptionAuth.recordImageRequestFailure(
      provider,
      cause instanceof Error
        ? `The ${meta.label} image health check failed: ${cause.message}`
        : `The ${meta.label} image health check failed.`,
    );
  }
}

const decodePatch = Schema.decodeUnknownSync(ImageGenerationSettingsPatch);

/** Decodes an untrusted patch body; throws ImageGenerationError on bad input. */
export function decodeImageGenerationPatch(input: unknown): ImageGenerationSettingsPatch {
  return decodePatch(input);
}

export function imageGenerationSettingsFromServerSettings(
  settings: ServerSettings,
): ImageGenerationSettings {
  return settings.imageGeneration;
}
