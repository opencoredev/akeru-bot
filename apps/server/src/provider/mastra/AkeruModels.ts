// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { opencodeClaudeMaxProvider } from "@mastra/code-sdk/providers/claude-max";
import { openaiCodexProvider } from "@mastra/code-sdk/providers/openai-codex";
import { xaiProvider } from "@mastra/code-sdk/providers/xai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { isThinkingLevelSetting } from "@mastra/code-sdk/thinking";
import { type ProviderDriverKind } from "@akeru/contracts";
import type { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import { akeruOpenAIProvider } from "../AkeruOpenAIProvider.ts";
import { akeruKimiProvider, type AkeruKimiAccess } from "../AkeruKimiProvider.ts";
import { akeruOpenCodeGoProvider } from "../AkeruOpenCodeGoProvider.ts";
import { type AkeruMastraState } from "./AkeruHarnessTypes.ts";

export const DEFAULT_MODEL_ID = "openai/gpt-5.6-sol";

export type AkeruRunOptions = {
  readonly providerOptions?: unknown;
  readonly [key: string]: unknown;
};

export function withAkeruModelRunOptions(
  runOptions: AkeruRunOptions,
  state: AkeruMastraState,
): AkeruRunOptions {
  const serviceTier = state.modelOptions?.serviceTier;
  if (!serviceTier) return runOptions;
  const providerOptions =
    typeof runOptions.providerOptions === "object" && runOptions.providerOptions !== null
      ? runOptions.providerOptions
      : {};
  const openai =
    "openai" in providerOptions &&
    typeof providerOptions.openai === "object" &&
    providerOptions.openai !== null
      ? providerOptions.openai
      : {};
  return {
    ...runOptions,
    providerOptions: {
      ...providerOptions,
      openai: { ...openai, serviceTier },
    },
  };
}

export const MASTRA_MODEL_PREFIX = {
  codex: "openai",
  claudeAgent: "anthropic",
  grok: "xai",
  kimi: "kimi-for-coding",
  opencodeGo: "opencode-go",
} as const;

export function mastraModelId(provider: ProviderDriverKind, model: string): string {
  const trimmed = model.trim();
  const prefix = MASTRA_MODEL_PREFIX[provider as keyof typeof MASTRA_MODEL_PREFIX];
  if (!prefix) return trimmed.includes("/") ? trimmed : `${provider}/${trimmed}`;
  const token = `${prefix}/`;
  return trimmed.startsWith(token) ? trimmed : `${token}${trimmed}`;
}

export function openCodeGoInlineConnection(environment: NodeJS.ProcessEnv | undefined): {
  readonly apiKey?: string;
  readonly baseUrl?: string;
} {
  const content = environment?.OPENCODE_CONFIG_CONTENT?.trim();
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as {
      readonly provider?: {
        readonly "opencode-go"?: {
          readonly options?: { readonly apiKey?: unknown; readonly baseURL?: unknown };
        };
      };
    };
    const options = parsed.provider?.["opencode-go"]?.options;
    const apiKey = typeof options?.apiKey === "string" ? options.apiKey.trim() : "";
    const baseUrl = typeof options?.baseURL === "string" ? options.baseURL.trim() : "";
    return {
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  } catch {
    return {};
  }
}

export function resolveAkeruMastraModel(
  modelId: string,
  authStorage: AuthStorage,
  getKimiAccess?: (instanceId?: string) => Promise<AkeruKimiAccess | undefined>,
  getOpenCodeGoApiKey?: (instanceId?: string) => Promise<string | undefined>,
  modelOptions?: AkeruMastraState["modelOptions"],
  getSubscriptionApiKey?: SubscriptionAuthService["getApiKeyCredential"],
  connection?: {
    readonly environment: NodeJS.ProcessEnv;
    readonly instanceEnvironment: NodeJS.ProcessEnv;
    readonly useSavedCredential: boolean;
    readonly instanceId?: string;
  },
  getSubscriptionOAuth?: SubscriptionAuthService["getOAuthCredential"],
  getSubscriptionAccessToken?: SubscriptionAuthService["getAccessToken"],
) {
  const trimmed = modelId.trim();
  const environment = connection?.useSavedCredential
    ? connection.environment
    : connection?.instanceEnvironment;
  const useSavedCredential = connection?.useSavedCredential !== false;
  const instanceId = connection?.instanceId;
  const savedApiKey = (provider: Parameters<NonNullable<typeof getSubscriptionApiKey>>[0]) =>
    instanceId ? getSubscriptionApiKey?.(provider, instanceId) : getSubscriptionApiKey?.(provider);
  const scopedAuthStorage =
    instanceId && getSubscriptionOAuth && getSubscriptionAccessToken
      ? Object.assign(Object.create(authStorage) as AuthStorage, {
          reload: () => {},
          get: (provider: string) =>
            getSubscriptionOAuth(
              provider as Parameters<typeof getSubscriptionOAuth>[0],
              instanceId,
            ),
          getApiKey: (provider: string) =>
            getSubscriptionAccessToken(
              provider as Parameters<typeof getSubscriptionAccessToken>[0],
              instanceId,
            ),
        })
      : authStorage;
  if (trimmed.startsWith("openai/")) {
    const instanceApiKey = environment?.OPENAI_API_KEY?.trim();
    const getCredential = instanceApiKey
      ? () => ({
          type: "api-key" as const,
          access: instanceApiKey,
          ...(environment?.OPENAI_BASE_URL?.trim()
            ? { baseUrl: environment.OPENAI_BASE_URL.trim() }
            : {}),
        })
      : useSavedCredential
        ? () => savedApiKey("openai-codex")
        : undefined;
    if (getCredential?.()) {
      return akeruOpenAIProvider(trimmed.slice("openai/".length), () => getCredential());
    }
    if (!useSavedCredential) {
      throw new Error("This Codex instance has no OPENAI_API_KEY transport for Akeru Mastra.");
    }
    const reasoningEffort = modelOptions?.reasoningEffort;
    return openaiCodexProvider(trimmed.slice("openai/".length), {
      authStorage: scopedAuthStorage,
      ...(isThinkingLevelSetting(reasoningEffort) ? { thinkingLevel: reasoningEffort } : {}),
    });
  }
  if (trimmed.startsWith("anthropic/")) {
    const model = trimmed.slice("anthropic/".length);
    const instanceApiKey = environment?.ANTHROPIC_API_KEY?.trim();
    const instanceAuthToken =
      environment?.ANTHROPIC_AUTH_TOKEN?.trim() ?? environment?.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (instanceApiKey || instanceAuthToken) {
      return createAnthropic({
        ...(instanceApiKey ? { apiKey: instanceApiKey } : { authToken: instanceAuthToken! }),
        ...(environment?.ANTHROPIC_BASE_URL?.trim()
          ? { baseURL: environment.ANTHROPIC_BASE_URL.trim() }
          : {}),
      })(model);
    }
    const credential = useSavedCredential ? savedApiKey("anthropic") : undefined;
    if (credential) {
      return createAnthropic({
        apiKey: credential.access,
        ...(credential.baseUrl ? { baseURL: credential.baseUrl } : {}),
      })(model);
    }
    if (!useSavedCredential) {
      throw new Error(
        "This Claude instance has no API key or auth token transport for Akeru Mastra.",
      );
    }
    return opencodeClaudeMaxProvider(model, { authStorage: scopedAuthStorage });
  }
  if (trimmed.startsWith("xai/")) {
    const model = trimmed.slice("xai/".length);
    const instanceApiKey = environment?.XAI_API_KEY?.trim();
    const credential = instanceApiKey
      ? {
          access: instanceApiKey,
          baseUrl: environment?.XAI_BASE_URL?.trim() || undefined,
        }
      : useSavedCredential
        ? savedApiKey("xai")
        : undefined;
    if (credential) {
      return createOpenAICompatible({
        name: "xai",
        apiKey: credential.access,
        baseURL: credential.baseUrl ?? "https://api.x.ai/v1",
      })(model);
    }
    if (!useSavedCredential) {
      throw new Error("This Grok instance has no XAI_API_KEY transport for Akeru Mastra.");
    }
    return xaiProvider(model, { authStorage: scopedAuthStorage });
  }
  if (trimmed.startsWith("kimi-for-coding/")) {
    if (!useSavedCredential) {
      throw new Error(
        "Custom Kimi instance credentials are not supported by the Akeru Mastra transport.",
      );
    }
    if (!getKimiAccess) throw new Error("Kimi For Coding subscription access is unavailable.");
    return akeruKimiProvider(trimmed.slice("kimi-for-coding/".length), () =>
      getKimiAccess(instanceId),
    );
  }
  if (trimmed.startsWith("opencode-go/")) {
    const inlineConnection = openCodeGoInlineConnection(environment);
    const instanceApiKey = environment?.OPENCODE_API_KEY?.trim() || inlineConnection.apiKey;
    const resolveApiKey = instanceApiKey
      ? async () => instanceApiKey
      : useSavedCredential && getOpenCodeGoApiKey
        ? () => getOpenCodeGoApiKey(instanceId)
        : undefined;
    if (!resolveApiKey) throw new Error("OpenCode Go subscription access is unavailable.");
    return akeruOpenCodeGoProvider(
      trimmed.slice("opencode-go/".length),
      resolveApiKey,
      () =>
        environment?.OPENCODE_BASE_URL?.trim() ||
        inlineConnection.baseUrl ||
        (useSavedCredential ? savedApiKey("opencode-go")?.baseUrl : undefined),
    );
  }
  throw new Error(`Mastra has no subscription transport for model '${modelId}'.`);
}
