import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@akeru/contracts";

/**
 * One configured codex instance with one default model keeps model
 * resolution deterministic in composer and bot engine tests.
 */
export const composerTestInstanceId = ProviderInstanceId.make("codex");
export const composerTestModelName = "Launchbar Model";

export function makeComposerTestProvider(): ServerProvider {
  return {
    instanceId: composerTestInstanceId,
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
        name: composerTestModelName,
        isCustom: false,
        isDefault: true,
        capabilities: {},
      },
    ],
    slashCommands: [],
    skills: [],
  };
}
