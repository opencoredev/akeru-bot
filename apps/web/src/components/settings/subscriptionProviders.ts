import type { SubscriptionProviderId } from "@t3tools/contracts";

import { ClaudeAI, OpenCodeIcon, type Icon } from "../Icons";

export interface SubscriptionProviderDefinition {
  readonly id: SubscriptionProviderId;
  readonly label: string;
  readonly subscription: string;
  readonly description: string;
  readonly icon: Icon | string;
}

export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProviderDefinition[] = [
  {
    id: "openai-codex",
    label: "ChatGPT",
    subscription: "Plus, Pro, Business, Enterprise, or Edu",
    description: "Use your ChatGPT subscription with Codex models.",
    icon: "/provider-icons/openai.svg",
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
    icon: "/provider-icons/xai.svg",
  },
  {
    id: "kimi-for-coding",
    label: "Kimi For Coding",
    subscription: "Kimi For Coding plan",
    description: "Use Kimi coding models through your Moonshot subscription.",
    icon: "/provider-icons/kimi-for-coding.svg",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    subscription: "OpenCode Go API key",
    description: "Use OpenCode Go models with an API key from OpenCode.",
    icon: OpenCodeIcon,
  },
];
