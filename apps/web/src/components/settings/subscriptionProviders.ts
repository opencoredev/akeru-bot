import type { MessageKey } from "@akeru/client-runtime/i18n";
import { providerUsesApiKey } from "@akeru/client-runtime/provider-auth";
import type { SubscriptionProviderId, SubscriptionProviderStatus } from "@akeru/contracts";

import type { useI18n } from "../../i18n";
import { ClaudeAI, GrokIcon, KimiIcon, OpenAI, OpenCodeIcon, type Icon } from "../Icons";

export interface SubscriptionProviderDefinition {
  readonly id: SubscriptionProviderId;
  readonly label: string;
  /** Catalog copy: render through `t`. */
  readonly subscription: MessageKey;
  readonly description: MessageKey;
  readonly icon: Icon | string;
}

/** An account's name in the list: its tier, such as "ChatGPT Pro", never its email. */
export function linkedAccountTitle(
  definition: SubscriptionProviderDefinition,
  status: SubscriptionProviderStatus,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (definition.id === "opencode-go") return definition.label;

  if (providerUsesApiKey(status)) return t("API key");

  return status.plan
    ? `${definition.label} ${status.plan}`
    : t("{provider} account", { provider: definition.label });
}

/** Row anchor in Providers settings, so other pages can open Settings on one provider. */
export function subscriptionProviderTargetId(id: SubscriptionProviderId): string {
  return `subscription-provider-${id}`;
}

export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProviderDefinition[] = [
  {
    id: "openai-codex",
    label: "ChatGPT",
    subscription: "Plus, Pro, Business, Enterprise, or Edu",
    description: "Use your ChatGPT subscription with Codex models.",
    icon: OpenAI,
  },
  {
    id: "anthropic",
    label: "Claude",
    subscription: "Pro or Max",
    description: "Use your Claude subscription with Claude Code models.",
    icon: ClaudeAI,
  },
  {
    id: "xai",
    label: "Grok",
    subscription: "Shared xAI login",
    description: "Connect an xAI login for Grok. Akeru cannot verify SuperGrok or X Premium+.",
    icon: GrokIcon,
  },
  {
    id: "kimi-for-coding",
    label: "Kimi For Coding",
    subscription: "Kimi For Coding plan",
    description: "Use Kimi coding models through your Moonshot subscription.",
    icon: KimiIcon,
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    subscription: "OpenCode Go API key",
    description: "Use OpenCode Go models with an API key from OpenCode.",
    icon: OpenCodeIcon,
  },
];
