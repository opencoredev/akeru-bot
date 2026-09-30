import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@akeru/contracts";

/**
 * One configured codex instance with one default model keeps model resolution
 * deterministic in composer and model picker tests.
 */
export function makeComposerTestProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5-codex",
        name: "Launchbar Model",
        isCustom: false,
        isDefault: true,
        capabilities: {},
      },
    ],
    slashCommands: [],
    skills: [],
  };
}
