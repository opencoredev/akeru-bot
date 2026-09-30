import {
  defaultInstanceIdForDriver,
  type ServerProvider,
  type SubscriptionProviderId,
  type SubscriptionProviderStatus,
} from "@akeru/contracts";

import { createTranslator, type MessageKey, type TranslationParams } from "./i18n/index.ts";
import { SUBSCRIPTION_PROVIDER_BY_DRIVER } from "./providerAuth.ts";

/** Translates guide copy. Defaults to English so callers without a locale keep working. */
export type ProviderAccessTranslate = (message: MessageKey, params?: TranslationParams) => string;

const englishTranslate: ProviderAccessTranslate = createTranslator("en").t;

/**
 * Access as the settings screens explain it. `ready` requires a provider
 * request that succeeded; a saved login or key alone stays `unverified`.
 */
export type ProviderAccessState =
  | "not-connected"
  | "checking"
  | "ready"
  | "unverified"
  | "expired"
  | "revoked"
  | "failed";

/**
 * `healthChecking` matches the optional contract field the server sets while it
 * runs the health check that follows a login. Declared here so statuses from
 * servers without the field still type-check.
 */
export type ProviderAccessStatusInput = Pick<
  SubscriptionProviderStatus,
  "connected" | "authMode" | "health" | "lastFailedRequest" | "credentialWarning"
> & { readonly healthChecking?: boolean | undefined };

export interface ProviderAccessGuide {
  readonly state: ProviderAccessState;
  readonly stateLabel: string;
  /** Which subscription unlocks the provider. */
  readonly unlockedBy: string;
  /** Another credential that also works, or null when the subscription is the only way in. */
  readonly alternative: string | null;
  readonly models: string;
  /** Whether the subscription includes API access. */
  readonly apiAccess: string;
  readonly limits: string;
  /** What this environment has saved, or what is missing. */
  readonly saved: string;
  readonly nextStep: string;
  /** Provider-reported failure text. Not translated. */
  readonly failure: string | null;
  /** Server text about a damaged credential file it is working around. Not translated. */
  readonly warning: string | null;
}

type GuidedProvider = Exclude<SubscriptionProviderId, "cursor">;

interface ProviderCopy {
  readonly unlockedBy: MessageKey;
  readonly alternative: MessageKey | null;
  readonly models: MessageKey;
  readonly apiAccess: MessageKey;
  readonly limits: MessageKey;
  readonly connect: MessageKey;
}

const PROVIDER_COPY: Readonly<Record<GuidedProvider, ProviderCopy>> = {
  "openai-codex": {
    unlockedBy: "ChatGPT Plus, Pro, Business, Enterprise, or Edu subscription.",
    alternative: "Or an OpenAI API key, billed separately by OpenAI.",
    models: "Codex models.",
    apiAccess: "A ChatGPT subscription does not include OpenAI API access.",
    limits:
      "OpenAI limits Codex use per 5-hour window and per week. The allowance depends on your plan.",
    connect: "Choose Connect and sign in with your ChatGPT account.",
  },
  anthropic: {
    unlockedBy: "Claude Pro or Max subscription.",
    alternative: "Or an Anthropic API key, billed separately in the Claude Console.",
    models: "Claude models.",
    apiAccess: "A Claude Pro or Max subscription does not include Anthropic API access.",
    limits:
      "Anthropic limits Claude use per 5-hour session and per week. Max allows more use than Pro.",
    connect: "Choose Connect and sign in with your Claude account.",
  },
  xai: {
    unlockedBy:
      "SuperGrok or X Premium+ on your xAI account. Akeru cannot see which plan the account has.",
    alternative: "Or an xAI API key, billed separately by xAI.",
    models: "Grok models.",
    apiAccess: "SuperGrok and X Premium+ do not include xAI API credits.",
    limits: "xAI does not publish Grok limits that Akeru can show.",
    connect: "Choose Connect and sign in with the xAI account that has SuperGrok or X Premium+.",
  },
  "kimi-for-coding": {
    unlockedBy: "Kimi For Coding membership.",
    alternative: "Or a Kimi For Coding API key from the Kimi Code console.",
    models: "Kimi coding models.",
    apiAccess:
      "The membership works only in coding tools. It does not include Moonshot Open Platform API credit.",
    limits: "Kimi sets limits by membership tier and shows them in the Kimi Code console.",
    connect: "Choose Connect and sign in with your Kimi account.",
  },
  "opencode-go": {
    unlockedBy: "OpenCode Go subscription API key.",
    alternative: null,
    models: "OpenCode Go models.",
    apiAccess: "The key is API access, but only to OpenCode Go models through OpenCode.",
    limits: "OpenCode Go limits use per 5-hour window, per week, and per month.",
    connect: "Choose Connect and paste your OpenCode Go API key.",
  },
};

const STATE_LABELS: Readonly<Record<ProviderAccessState, MessageKey>> = {
  "not-connected": "Not connected",
  checking: "Checking access",
  ready: "Ready",
  unverified: "Not verified yet",
  expired: "Login expired",
  revoked: "Access revoked",
  failed: "Check failed",
};

/**
 * Only a successful provider request makes access ready. The server reports
 * `unsupported` and `disabled` for provider rows, never for subscription logins,
 * so a login with either value falls back to unverified.
 */
export function providerAccessState(
  status: ProviderAccessStatusInput | undefined,
): ProviderAccessState {
  if (status?.connected !== true) return "not-connected";
  if (status.healthChecking === true) return "checking";
  switch (status.health) {
    case "healthy":
    case "recovered":
      return "ready";
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    case "failed":
    case "failed-first-request":
      return "failed";
    default:
      return "unverified";
  }
}

function nextStep(
  state: ProviderAccessState,
  copy: ProviderCopy,
  apiKey: boolean,
  t: ProviderAccessTranslate,
): string {
  switch (state) {
    case "not-connected":
      return t(copy.connect);
    case "checking":
      return t("Wait for the health check to finish.");
    case "ready":
      return t("No action needed. A provider request succeeded.");
    case "unverified":
      return apiKey
        ? t("Choose Check key to send a health request.")
        : t("Choose Check OAuth to send a health request.");
    case "expired":
    case "revoked":
      return apiKey
        ? t("Choose Reconnect key and enter a current key.")
        : t("Choose Reconnect and sign in again.");
    case "failed":
      return apiKey
        ? t("Check the key and its billing, then choose Check key.")
        : t("Check that the subscription is active, then choose Reconnect.");
  }
}

function savedCredential(
  provider: GuidedProvider,
  status: ProviderAccessStatusInput | undefined,
  apiKey: boolean,
  t: ProviderAccessTranslate,
): string {
  if (status?.connected !== true) {
    return provider === "opencode-go"
      ? t("Missing: no OpenCode Go API key in this environment.")
      : t("Missing: no subscription login or API key in this environment.");
  }
  return apiKey
    ? t("API key saved in this environment.")
    : t("Subscription login saved in this environment.");
}

const MAX_LISTED_MODELS = 4;

/**
 * Model names the environment's default instance offers for one subscription
 * connection. Custom instances keep their own credentials, so they are left out.
 */
export function providerAccessModelNames(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "models">> | undefined,
  provider: SubscriptionProviderId,
): ReadonlyArray<string> {
  const instance = providers?.find(
    (candidate) =>
      SUBSCRIPTION_PROVIDER_BY_DRIVER[String(candidate.driver)] === provider &&
      candidate.instanceId === defaultInstanceIdForDriver(candidate.driver),
  );
  return instance?.models.filter((model) => !model.isCustom).map((model) => model.name) ?? [];
}

/**
 * Explains which subscription or credential unlocks a provider, what this
 * environment has, and the one step that moves access forward. Pass the
 * environment's live model names to list them instead of the generic family.
 */
export function providerAccessGuide(
  provider: SubscriptionProviderId,
  status: ProviderAccessStatusInput | undefined,
  options: {
    readonly models?: ReadonlyArray<string> | undefined;
    readonly t?: ProviderAccessTranslate | undefined;
  } = {},
): ProviderAccessGuide | null {
  const t = options.t ?? englishTranslate;
  const copy = PROVIDER_COPY[provider];
  const state = providerAccessState(status);
  const apiKey = provider === "opencode-go" || status?.authMode === "api-key";
  const models = options.models ?? [];
  const listed = models.slice(0, MAX_LISTED_MODELS).join(", ");
  return {
    state,
    stateLabel: t(STATE_LABELS[state]),
    unlockedBy: t(copy.unlockedBy),
    alternative: copy.alternative ? t(copy.alternative) : null,
    models:
      models.length === 0
        ? t(copy.models)
        : models.length > MAX_LISTED_MODELS
          ? t("{models}, and {count} more.", {
              models: listed,
              count: models.length - MAX_LISTED_MODELS,
            })
          : t("{models}.", { models: listed }),
    apiAccess: t(copy.apiAccess),
    limits: t(copy.limits),
    saved: savedCredential(provider, status, apiKey, t),
    nextStep: nextStep(state, copy, apiKey, t),
    failure:
      state === "failed" || state === "expired" || state === "revoked"
        ? (status?.lastFailedRequest?.message ?? null)
        : null,
    warning: status?.credentialWarning?.message ?? null,
  };
}
