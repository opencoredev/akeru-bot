import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@akeru/contracts";

export function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  installed?: boolean;
  availability?: ServerProvider["availability"];
  authStatus?: ServerProvider["auth"]["status"];
  displayName?: string;
  accentColor?: string;
  status?: ServerProvider["status"];
  models?: ServerProvider["models"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

export const model = (slug: string, isCustom = false, isDefault = false) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {},
});
