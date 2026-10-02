import {
  ProviderInstanceId,
  type BotEngine,
  type ModelSelection,
  type SubscriptionProviderId,
} from "@akeru/contracts";

interface DesktopOnboardingProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly availability?: "available" | "unavailable" | undefined;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean | undefined;
  }>;
}

export type DesktopOnboardingCreationReadiness =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly engine: BotEngine };

const subscriptionDriver: Readonly<Partial<Record<SubscriptionProviderId, string>>> = {
  "openai-codex": "codex",
  anthropic: "claudeAgent",
  xai: "grok",
  "kimi-for-coding": "kimi",
  "opencode-go": "opencodeGo",
};

export function resolveDesktopOnboardingEngine(
  providerId: SubscriptionProviderId,
  providers: ReadonlyArray<DesktopOnboardingProvider>,
): BotEngine | null {
  const provider = providers.find(
    (candidate) =>
      candidate.driver === subscriptionDriver[providerId] &&
      candidate.enabled &&
      candidate.installed &&
      candidate.availability !== "unavailable",
  );

  const model = provider?.models.find((candidate) => candidate.isDefault) ?? provider?.models[0];

  return provider && model ? { provider: provider.instanceId, model: model.slug } : null;
}

export function resolveDesktopOnboardingCreationReadiness(
  providerId: SubscriptionProviderId,
  providers: ReadonlyArray<DesktopOnboardingProvider> | null,
): DesktopOnboardingCreationReadiness {
  if (providers === null) return { status: "loading" };
  const engine = resolveDesktopOnboardingEngine(providerId, providers);

  return engine ? { status: "ready", engine } : { status: "unavailable" };
}

export function desktopOnboardingModelSelection(engine: BotEngine | null): ModelSelection | null {
  return engine
    ? { instanceId: ProviderInstanceId.make(engine.provider), model: engine.model }
    : null;
}
