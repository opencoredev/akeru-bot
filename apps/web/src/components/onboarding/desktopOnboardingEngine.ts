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
  readonly status?: string | undefined;
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

/**
 * Drivers that run each account, first choice first. Claude also runs on the
 * user's Claude Code login, which wins only when it is ready and the API key
 * connection is not.
 */
const subscriptionDrivers: Readonly<Partial<Record<SubscriptionProviderId, readonly string[]>>> = {
  "openai-codex": ["codex"],
  anthropic: ["claudeAgent", "claudeCode"],
  xai: ["grok"],
  "kimi-for-coding": ["kimi"],
  "opencode-go": ["opencodeGo"],
};

export function resolveDesktopOnboardingEngine(
  providerId: SubscriptionProviderId,
  providers: ReadonlyArray<DesktopOnboardingProvider>,
): BotEngine | null {
  const drivers = subscriptionDrivers[providerId] ?? [];

  const usable = providers.filter(
    (candidate) =>
      drivers.includes(candidate.driver) &&
      candidate.enabled &&
      candidate.installed &&
      candidate.availability !== "unavailable",
  );

  const byPreference = (candidates: ReadonlyArray<DesktopOnboardingProvider>) =>
    drivers.flatMap((driver) => candidates.filter((candidate) => candidate.driver === driver));

  const firstChoice = usable.find((candidate) => candidate.driver === drivers[0]);

  const provider =
    drivers.length > 1
      ? (byPreference(usable.filter((candidate) => candidate.status === "ready"))[0] ?? firstChoice)
      : firstChoice;

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
