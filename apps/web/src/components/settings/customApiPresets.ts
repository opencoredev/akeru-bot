import type { ProviderInstanceEnvironmentVariable } from "@akeru/contracts";

import { CustomApiIcon, type Icon } from "../Icons";
import {
  DeepSeekLogo,
  FireworksLogo,
  GroqLogo,
  LmStudioLogo,
  MistralLogo,
  OllamaLogo,
  OpenRouterLogo,
  TogetherLogo,
  VllmLogo,
} from "../icons/CustomApiPresetIcons";

/** The instance variable the Custom API driver reads its key from. */
export const CUSTOM_API_KEY_ENV = "CUSTOM_OPENAI_API_KEY";

export interface CustomApiPreset {
  readonly id: string;
  readonly label: string;
  readonly tagline: string;
  readonly icon: Icon;
  /** Empty for "Other", where the user types the URL. */
  readonly baseUrl: string;
  readonly key:
    | { readonly kind: "required"; readonly url: string }
    | { readonly kind: "optional" }
    | { readonly kind: "none" };
}

/**
 * Services the add dialog offers as one-click starting points. Local entries
 * resolve on the machine running the environment server, not the browser.
 */
export const CUSTOM_API_PRESETS: readonly CustomApiPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    tagline: "Hundreds of models, one key",
    icon: OpenRouterLogo,
    baseUrl: "https://openrouter.ai/api/v1",
    key: { kind: "required", url: "https://openrouter.ai/settings/keys" },
  },
  {
    id: "groq",
    label: "Groq",
    tagline: "Fast hosted open models",
    icon: GroqLogo,
    baseUrl: "https://api.groq.com/openai/v1",
    key: { kind: "required", url: "https://console.groq.com/keys" },
  },
  {
    id: "together",
    label: "Together AI",
    tagline: "Hosted open models",
    icon: TogetherLogo,
    baseUrl: "https://api.together.ai/v1",
    key: { kind: "required", url: "https://api.together.ai/settings/api-keys" },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    tagline: "DeepSeek's own API",
    icon: DeepSeekLogo,
    baseUrl: "https://api.deepseek.com/v1",
    key: { kind: "required", url: "https://platform.deepseek.com/api_keys" },
  },
  {
    id: "mistral",
    label: "Mistral",
    tagline: "Mistral and Codestral",
    icon: MistralLogo,
    baseUrl: "https://api.mistral.ai/v1",
    key: { kind: "required", url: "https://console.mistral.ai/api-keys" },
  },
  {
    id: "fireworks",
    label: "Fireworks",
    tagline: "Hosted open models",
    icon: FireworksLogo,
    baseUrl: "https://api.fireworks.ai/inference/v1",
    key: { kind: "required", url: "https://fireworks.ai/account/api-keys" },
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    tagline: "Local models, no key",
    icon: LmStudioLogo,
    baseUrl: "http://localhost:1234/v1",
    key: { kind: "none" },
  },
  {
    id: "ollama",
    label: "Ollama",
    tagline: "Local models, no key",
    icon: OllamaLogo,
    baseUrl: "http://localhost:11434/v1",
    key: { kind: "none" },
  },
  {
    id: "vllm",
    label: "vLLM",
    tagline: "Your own inference server",
    icon: VllmLogo,
    baseUrl: "http://localhost:8000/v1",
    key: { kind: "optional" },
  },
  {
    id: "other",
    label: "Other",
    tagline: "Any OpenAI-compatible URL",
    icon: CustomApiIcon,
    baseUrl: "",
    key: { kind: "optional" },
  },
];

export const OTHER_CUSTOM_API_PRESET = CUSTOM_API_PRESETS.at(-1)!;

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/** The preset whose base URL the instance uses, or "Other" for anything else. */
export function customApiPresetForBaseUrl(baseUrl: string): CustomApiPreset {
  const normalized = normalizeBaseUrl(baseUrl);

  if (normalized.length === 0) return OTHER_CUSTOM_API_PRESET;

  return (
    CUSTOM_API_PRESETS.find(
      (preset) => preset.baseUrl.length > 0 && normalizeBaseUrl(preset.baseUrl) === normalized,
    ) ?? OTHER_CUSTOM_API_PRESET
  );
}

/** Hint shown under the API key field for the given preset. */
export function customApiKeyHint(preset: CustomApiPreset): string {
  switch (preset.key.kind) {
    case "required":
      return `Required. Create one at ${preset.key.url.replace(/^https:\/\//, "")}.`;
    case "none":
      return "Not needed for this server. Leave it empty.";
    case "optional":
      return "Leave empty if the endpoint does not need one.";
  }
}

export function readCustomApiKey(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ProviderInstanceEnvironmentVariable | undefined {
  return environment.find((variable) => variable.name === CUSTOM_API_KEY_ENV);
}

export function withoutCustomApiKey(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ProviderInstanceEnvironmentVariable[] {
  return environment.filter((variable) => variable.name !== CUSTOM_API_KEY_ENV);
}

/**
 * Store the key as a sensitive instance variable so it lives in the secret
 * store and is redacted from settings. An empty value removes it.
 */
export function withCustomApiKey(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  value: string,
): ProviderInstanceEnvironmentVariable[] {
  const rest = withoutCustomApiKey(environment);
  const trimmed = value.trim();

  return trimmed.length === 0
    ? rest
    : [...rest, { name: CUSTOM_API_KEY_ENV, value: trimmed, sensitive: true }];
}

/**
 * Merge edits from the generic environment editor with the stored key. The
 * key field owns the reserved name, so a generic row with that name is
 * dropped instead of replacing (and, when empty, deleting) the stored key.
 */
export function withStoredCustomApiKey(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  stored: ProviderInstanceEnvironmentVariable | undefined,
): ProviderInstanceEnvironmentVariable[] {
  const rest = withoutCustomApiKey(environment);

  return stored ? [...rest, stored] : rest;
}

/** The instance variable that overrides the configured base URL. */
const CUSTOM_API_BASE_URL_ENV = "CUSTOM_OPENAI_BASE_URL";

/** The parts of a saved instance that decide where its key is sent. */
export interface CustomApiEndpoint {
  readonly baseUrl: string;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
}

function sameVariable(
  left: ProviderInstanceEnvironmentVariable | undefined,
  right: ProviderInstanceEnvironmentVariable | undefined,
): boolean {
  return (
    left?.value === right?.value &&
    left?.sensitive === right?.sensitive &&
    left?.valueRedacted === right?.valueRedacted
  );
}

function urlLeaves(previousBaseUrl: string, nextBaseUrl: string): boolean {
  const previous = previousBaseUrl.trim();
  const next = nextBaseUrl.trim();

  if (previous.length === 0) return false;

  if (!URL.canParse(previous) || !URL.canParse(next)) return previous !== next;

  const before = new URL(previous);
  const after = new URL(next);

  return (
    before.host !== after.host || (before.protocol === "https:" && after.protocol !== "https:")
  );
}

/**
 * A stored key belongs to the endpoint it was saved for. The driver sends it to
 * `CUSTOM_OPENAI_BASE_URL` when that variable is set and to the configured base
 * URL otherwise (the last row wins when the variable repeats), so the key must
 * go when that address moves to another host or drops from HTTPS to HTTP. A
 * first URL on an instance that had none keeps the key. A redacted override
 * cannot be read, so any change to it drops the key, and so does a base URL
 * move behind it, since a blank override falls back to the base URL.
 */
export function customApiKeyLeavesEndpoint(
  previous: CustomApiEndpoint,
  next: CustomApiEndpoint,
): boolean {
  const override = (endpoint: CustomApiEndpoint) =>
    endpoint.environment.findLast((variable) => variable.name === CUSTOM_API_BASE_URL_ENV);

  const previousOverride = override(previous);
  const nextOverride = override(next);

  if (previousOverride?.valueRedacted === true || nextOverride?.valueRedacted === true) {
    return (
      !sameVariable(previousOverride, nextOverride) || urlLeaves(previous.baseUrl, next.baseUrl)
    );
  }

  const effective = (endpoint: CustomApiEndpoint) =>
    override(endpoint)?.value.trim() || endpoint.baseUrl;

  return urlLeaves(effective(previous), effective(next));
}
