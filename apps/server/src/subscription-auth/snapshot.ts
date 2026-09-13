import type {
  BotEngine,
  BotId,
  McpServer,
  McpServerId,
  ProviderAccessStatus,
  ServerProvider,
} from "@t3tools/contracts";

import type { ProviderStatus, RequestHealthStatus, SubscriptionProviderId } from "./service.ts";

const SUBSCRIPTION_ACCESS = [
  { id: "chatgpt", label: "ChatGPT", provider: "openai-codex" },
  { id: "claude-max", label: "Claude Max", provider: "anthropic" },
  { id: "cursor-pro", label: "Cursor Pro", provider: "cursor" },
] as const;

const SUBSCRIPTION_DRIVER: Readonly<Record<SubscriptionProviderId, string>> = {
  anthropic: "claudeAgent",
  "openai-codex": "codex",
  cursor: "cursor",
  xai: "grok",
  "kimi-for-coding": "kimi",
  "opencode-go": "opencodeGo",
};

export function subscriptionDependentBots(
  bots: ReadonlyArray<{
    readonly id: BotId;
    readonly name: string;
    readonly engine: BotEngine | null;
  }>,
  providers: ReadonlyArray<ServerProvider>,
) {
  return bots.flatMap((bot) => {
    if (!bot.engine) return [];
    const driver =
      providers.find((provider) => provider.instanceId === bot.engine?.provider)?.driver ??
      bot.engine.provider;
    const subscriptionProvider = Object.entries(SUBSCRIPTION_DRIVER).find(
      ([, candidate]) => candidate === driver,
    )?.[0] as SubscriptionProviderId | undefined;
    return subscriptionProvider
      ? [{ id: bot.id, name: bot.name, provider: subscriptionProvider }]
      : [];
  });
}

type ActualRequestHealth = "healthy" | "failed" | "failed-first-request" | "recovered" | undefined;

type BotAccess = {
  readonly id: BotId;
  readonly name: string;
  readonly engine: BotEngine | null;
  readonly disabledMcpServerIds?: ReadonlyArray<McpServerId>;
};

function requestHealthState(
  health: ActualRequestHealth | RequestHealthStatus,
): ActualRequestHealth {
  return typeof health === "string" || health === undefined ? health : health.health;
}

function requestHealthFields(health: ActualRequestHealth | RequestHealthStatus) {
  return typeof health === "object"
    ? {
        ...(health.lastSuccessfulRequestAt
          ? { lastSuccessfulRequestAt: health.lastSuccessfulRequestAt }
          : {}),
        ...(health.lastFailedRequest ? { lastFailedRequest: health.lastFailedRequest } : {}),
        ...(health.nextRetryAt ? { nextRetryAt: health.nextRetryAt } : {}),
      }
    : {};
}

function dependentBotsForProvider(bots: ReadonlyArray<BotAccess>, instanceId: string) {
  return bots
    .filter((bot) => bot.engine?.provider === instanceId)
    .map(({ id, name }) => ({ id, name }));
}

function providerAccessHealth(
  provider: ServerProvider | undefined,
  actualRequestHealth: ActualRequestHealth,
) {
  if (!provider || !provider.installed) return "missing" as const;
  if (provider.availability === "unavailable") return "unsupported" as const;
  if (actualRequestHealth) return actualRequestHealth;
  if (provider.status === "error") return "failed-first-request" as const;
  return "detected" as const;
}

export function buildProviderAccessCapabilities(
  subscriptions: ReadonlyArray<ProviderStatus>,
  providers: ReadonlyArray<ServerProvider>,
  providerRequestHealth: (instanceId: string) => ActualRequestHealth | RequestHealthStatus = () =>
    undefined,
  mcpServers: ReadonlyArray<McpServer> = [],
  bots: ReadonlyArray<BotAccess> = [],
  mcpRequestHealth: (serverId: string) => RequestHealthStatus | undefined = () => undefined,
): ReadonlyArray<ProviderAccessStatus> {
  const subscriptionById = new Map(subscriptions.map((status) => [status.provider, status]));
  const subscriptionRows = SUBSCRIPTION_ACCESS.map((entry) => {
    const status = subscriptionById.get(entry.provider);
    return {
      id: entry.id,
      label: entry.label,
      accessMethod:
        status?.authMode === "api-key" ? ("api-key" as const) : ("subscription-oauth" as const),
      health: status?.health ?? ("missing" as const),
      apiAccess: "separate" as const,
      nextAction:
        status?.health === "healthy" || status?.health === "recovered"
          ? "Send a provider request after the provider changes access."
          : status?.connected
            ? status.authMode === "api-key"
              ? "Check the API key, then send a provider request to verify access."
              : "Check OAuth, then send a provider request to verify access."
            : `Connect ${entry.label} in Settings.`,
      ...(status?.lastSuccessfulRequestAt
        ? { lastSuccessfulRequestAt: status.lastSuccessfulRequestAt }
        : {}),
      ...(status?.lastFailedRequest ? { lastFailedRequest: status.lastFailedRequest } : {}),
      ...(status?.nextRetryAt ? { nextRetryAt: status.nextRetryAt } : {}),
      reconnectAction: status?.reconnectAction ?? `Connect ${entry.label}`,
      dependentBots: status?.dependentBots ?? [],
    };
  });

  const apiKeyProviders = providers.filter((provider) => provider.auth.type === "apiKey");
  const apiKeyRows = apiKeyProviders.map((provider) => {
    const requestHealth = providerRequestHealth(provider.instanceId);
    const health = providerAccessHealth(provider, requestHealthState(requestHealth));
    return {
      id: `api-key-${provider.instanceId}`,
      label: `${provider.displayName ?? provider.driver} API key`,
      accessMethod: "api-key" as const,
      health,
      apiAccess: "included" as const,
      nextAction:
        health === "failed" || health === "failed-first-request"
          ? "Check the API key and billing, then retry a provider request."
          : "Send a provider request to verify the key and billing.",
      ...requestHealthFields(requestHealth),
      reconnectAction: "Update key",
      dependentBots: dependentBotsForProvider(bots, provider.instanceId),
    };
  });

  const acpRows = [{ id: "grok-acp", label: "Grok ACP CLI", driver: "grok" }].map((entry) => {
    const provider = providers.find((candidate) => candidate.driver === entry.driver);
    const requestHealth = provider ? providerRequestHealth(provider.instanceId) : undefined;
    const health = providerAccessHealth(provider, requestHealthState(requestHealth));
    return {
      id: entry.id,
      label: entry.label,
      accessMethod: "acp-cli" as const,
      health,
      apiAccess: "not-applicable" as const,
      nextAction:
        health === "failed" || health === "failed-first-request"
          ? (provider?.message ?? "The first provider request failed.")
          : provider
            ? `Send a request through ${entry.label} to verify access.`
            : `Install and sign in to the ${entry.label}.`,
      ...requestHealthFields(requestHealth),
      reconnectAction: "Reconnect CLI",
      dependentBots: provider ? dependentBotsForProvider(bots, provider.instanceId) : [],
    };
  });

  const mcpRows = mcpServers.map((server) => {
    const requestHealth = mcpRequestHealth(server.id);
    const health: ProviderAccessStatus["health"] = server.enabled
      ? (requestHealth?.health ?? "detected")
      : "disabled";
    return {
      id: `mcp-${server.id}`,
      label: server.name,
      accessMethod: "mcp" as const,
      health,
      apiAccess: "not-applicable" as const,
      nextAction:
        health === "disabled"
          ? `Enable ${server.name} to use it again.`
          : health === "failed" || health === "failed-first-request"
            ? `Reconnect ${server.name}, then retry its failed request.`
            : health === "healthy" || health === "recovered"
              ? `Disable or remove ${server.name} when it is no longer needed.`
              : `Send a request through ${server.name} to verify the connection.`,
      ...(health === "disabled"
        ? { repairAction: "Enable" }
        : health === "failed" || health === "failed-first-request"
          ? { repairAction: "Reconnect" }
          : {}),
      reconnectAction: "Reconnect",
      serverId: String(server.id),
      ...(String(server.id).startsWith("builtin-")
        ? { pluginId: String(server.id).slice("builtin-".length) }
        : {}),
      ...requestHealthFields(requestHealth),
      dependentBots: bots
        .filter((bot) => !bot.disabledMcpServerIds?.includes(server.id))
        .map(({ id, name }) => ({ id, name })),
    };
  });

  return [
    ...subscriptionRows,
    {
      id: "xai-subscription",
      label: "xAI subscription login",
      accessMethod:
        subscriptionById.get("xai")?.authMode === "api-key"
          ? ("api-key" as const)
          : ("subscription-oauth" as const),
      health: subscriptionById.get("xai")?.health ?? ("missing" as const),
      apiAccess: "separate" as const,
      nextAction: "Send a Grok request to verify the shared xAI login.",
    },
    {
      id: "supergrok",
      label: "SuperGrok",
      accessMethod: "subscription-oauth" as const,
      health: "unsupported" as const,
      apiAccess: "separate" as const,
      nextAction: "Akeru cannot distinguish this plan from the shared xAI login.",
    },
    {
      id: "x-premium-plus",
      label: "X Premium+",
      accessMethod: "subscription-oauth" as const,
      health: "unsupported" as const,
      apiAccess: "separate" as const,
      nextAction: "Akeru cannot verify this plan from the shared xAI login.",
    },
    ...(apiKeyRows.length > 0
      ? apiKeyRows
      : [
          {
            id: "api-keys",
            label: "API keys",
            accessMethod: "api-key" as const,
            health: "missing" as const,
            apiAccess: "included" as const,
            nextAction: "Add a provider API key, then send a provider request.",
          },
        ]),
    ...acpRows,
    ...mcpRows,
    {
      id: "email-browser",
      label: "Email browser session",
      accessMethod: "browser" as const,
      health: "unsupported" as const,
      apiAccess: "not-applicable" as const,
      nextAction: "Use a supported email connector when one is available.",
      temporary: true,
      repairAction: "Add an email connector or configure it through Executor, then reconnect it.",
    },
    {
      id: "shopping-browser",
      label: "Shopping browser session",
      accessMethod: "browser" as const,
      health: "unsupported" as const,
      apiAccess: "not-applicable" as const,
      nextAction: "Use the browser session only for this task.",
      temporary: true,
      repairAction: "Add a shopping connector when Akeru supports one.",
    },
    {
      id: "booking-browser",
      label: "Booking browser session",
      accessMethod: "browser" as const,
      health: "unsupported" as const,
      apiAccess: "not-applicable" as const,
      nextAction: "Use the browser session only for this approved booking.",
      temporary: true,
      repairAction: "Add a calendar or booking connector when Akeru supports one.",
    },
  ].map((row) => ({ dependentBots: [], dependentRoutines: [], ...row }));
}
