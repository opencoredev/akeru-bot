import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import type { ProviderInstanceConfig } from "./providerInstance.ts";
import type { SubscriptionProviderId } from "./subscriptionAuth.ts";

const decodeConfigJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Environment variables that give a provider instance its own connection. */
export const SUBSCRIPTION_CONNECTION_ENV_KEYS: Partial<
  Record<SubscriptionProviderId, ReadonlyArray<string>>
> = {
  "openai-codex": ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME"],
  anthropic: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CONFIG_DIR",
  ],
  xai: ["XAI_API_KEY", "XAI_BASE_URL"],
  "kimi-for-coding": ["KIMI_API_KEY", "KIMI_BASE_URL"],
  "opencode-go": ["OPENCODE_API_KEY", "OPENCODE_BASE_URL"],
};

/** False when the instance brings its own connection, so a saved provider-wide key does not reach it. */
export function instanceUsesSavedCredential(
  provider: SubscriptionProviderId,
  instance: ProviderInstanceConfig | undefined,
): boolean {
  if (!instance) return true;
  const connectionKeys = SUBSCRIPTION_CONNECTION_ENV_KEYS[provider] ?? [];

  if (instance.environment?.some(({ name }) => connectionKeys.includes(name))) return false;

  if (provider === "opencode-go") {
    const inlineConfig = instance.environment?.find(
      ({ name }) => name === "OPENCODE_CONFIG_CONTENT",
    )?.value;

    if (inlineConfig) {
      try {
        const config = decodeConfigJson(inlineConfig);

        if (config === null) return false;

        // Optional access also accepts JSON primitives, matching provider CLI config handling.
        const providerConfig =
          Predicate.isObject(config) && "provider" in config ? config.provider : undefined;

        const instanceConfig =
          Predicate.isObject(providerConfig) && "opencode-go" in providerConfig
            ? providerConfig["opencode-go"]
            : undefined;

        const options =
          Predicate.isObject(instanceConfig) && "options" in instanceConfig
            ? instanceConfig.options
            : undefined;

        if (options && (Object.hasOwn(options, "apiKey") || Object.hasOwn(options, "baseURL"))) {
          return false;
        }
      } catch {
        return false;
      }
    }
  }

  if (provider === "anthropic") {
    const config = instance.config;

    const homePath =
      Predicate.isObjectOrArray(config) && "homePath" in config ? config.homePath : undefined;

    if (Predicate.isString(homePath) && homePath.trim().length > 0) return false;
  }

  if (provider === "openai-codex") {
    const config = instance.config;

    const homePath =
      Predicate.isObjectOrArray(config) && "homePath" in config ? config.homePath : undefined;

    if (Predicate.isString(homePath) && homePath.trim().length > 0) return false;
  }

  return true;
}
