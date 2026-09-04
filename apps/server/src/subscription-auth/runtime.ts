import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import {
  anthropicApiBaseUrl,
  SubscriptionAuthService,
  type SubscriptionProviderId,
} from "./service.ts";

const explicitEnvironmentKeys = Symbol("subscriptionInstanceEnvironmentKeys");
type SubscriptionEnvironment = NodeJS.ProcessEnv & {
  readonly [explicitEnvironmentKeys]?: ReadonlySet<string>;
};

/** The symbol survives environment spreads without becoming a child-process variable. */
export function mergeSubscriptionInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): SubscriptionEnvironment {
  return {
    ...mergeProviderInstanceEnvironment(environment, baseEnv),
    [explicitEnvironmentKeys]: new Set(environment?.map(({ name }) => name)),
  };
}

function hasExplicitEnvironmentKey(environment: SubscriptionEnvironment, key: string): boolean {
  const keys = environment[explicitEnvironmentKeys];
  return keys ? keys.has(key) : environment !== process.env && Object.hasOwn(environment, key);
}

const CONNECTION_ENV_KEYS: Partial<Record<SubscriptionProviderId, ReadonlyArray<string>>> = {
  anthropic: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CONFIG_DIR",
  ],
  xai: ["XAI_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
};

const ConfigRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(ConfigRecord));
const decodeRecord = Schema.decodeUnknownSync(ConfigRecord);

/** Read saved API keys at process start, not when the provider registry starts. */
export function subscriptionRuntimeEnvironment(
  secretsDir: string,
  provider: SubscriptionProviderId,
  environment: SubscriptionEnvironment = process.env,
): NodeJS.ProcessEnv {
  const connectionKeys = CONNECTION_ENV_KEYS[provider] ?? [];
  if (connectionKeys.some((key) => hasExplicitEnvironmentKey(environment, key))) return environment;
  const credential =
    SubscriptionAuthService.forSecretsDir(secretsDir).getApiKeyCredential(provider);
  if (!credential) return environment;
  const { [explicitEnvironmentKeys]: _explicitKeys, ...env } = environment;
  switch (provider) {
    case "anthropic":
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.ANTHROPIC_AUTH_TOKEN;
      env.ANTHROPIC_API_KEY = credential.access;
      if (credential.baseUrl) env.ANTHROPIC_BASE_URL = anthropicApiBaseUrl(credential.baseUrl);
      else delete env.ANTHROPIC_BASE_URL;
      break;
    case "xai":
      env.XAI_API_KEY = credential.access;
      break;
    case "opencode-go": {
      const config = decodeConfig(env.OPENCODE_CONFIG_CONTENT ?? "{}");
      const providers = decodeRecord(config.provider ?? {});
      const providerConfig = decodeRecord(providers["opencode-go"] ?? {});
      const options = decodeRecord(providerConfig.options ?? {});
      if (
        hasExplicitEnvironmentKey(environment, "OPENCODE_CONFIG_CONTENT") &&
        (Object.hasOwn(options, "apiKey") || Object.hasOwn(options, "baseURL"))
      )
        return environment;
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        ...config,
        provider: {
          ...providers,
          "opencode-go": {
            ...providerConfig,
            options: {
              ...options,
              apiKey: credential.access,
              baseURL: credential.baseUrl ?? "https://opencode.ai/zen/go/v1",
            },
          },
        },
      });
      break;
    }
  }
  return env;
}

/** Keep the SDK's endpoint suffix and request body when changing API origins. */
export function subscriptionRequestUrl(
  input: string | URL | Request,
  defaultBaseUrl: string,
  baseUrl: string | undefined,
): string | URL | Request {
  if (!baseUrl) return input;
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(`${defaultBaseUrl}/`)) {
    throw new Error("The provider request does not match its API base URL.");
  }
  const target = `${baseUrl}${url.slice(defaultBaseUrl.length)}`;
  return input instanceof Request ? new Request(target, input) : target;
}
