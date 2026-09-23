import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { makeComposerTestProvider } from "../../test/composerTestProvider";
import { botEngineCatalog, resolveStickyBotEngine } from "./botEngineSelection";
import { isCurrentGroupPerson } from "./roster.logic";
import { resolveAvailableGroupBoss } from "./GroupThreadLanding";

describe("group thread person placement", () => {
  it("keeps legacy host messages on the right for the host", () => {
    expect(isCurrentGroupPerson(null, "person-host", "person-host")).toBe(true);
  });

  it("puts legacy host messages on the left for a guest", () => {
    expect(isCurrentGroupPerson(null, "person-guest", "person-host")).toBe(false);
  });

  it("puts another paired person's message on the left", () => {
    expect(isCurrentGroupPerson("person-guest", "person-host", "person-host")).toBe(false);
  });
});

describe("group boss availability", () => {
  it("keeps the landing available when the configured boss is unavailable", () => {
    expect(resolveAvailableGroupBoss([{ id: "specialist" }], "boss")).toBeNull();
  });
});

describe("group composer menus", () => {
  it("offers the boss's skills and commands when a specialist uses another provider", () => {
    const codex = {
      ...makeComposerTestProvider(),
      skills: [{ name: "ship", path: "/skills/ship/SKILL.md", enabled: true }],
      slashCommands: [{ name: "status" }],
    };
    const claude = {
      ...makeComposerTestProvider(),
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      models: [
        {
          slug: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          isCustom: false,
          isDefault: true,
          capabilities: {},
        },
      ],
      skills: [{ name: "review", path: "/skills/review/SKILL.md", enabled: true }],
      slashCommands: [{ name: "compact" }],
    };
    const providers = [codex, claude];
    const instanceEntries = deriveProviderInstanceEntries(providers);
    const members = [
      { id: "specialist", engine: { provider: claude.instanceId, model: "claude-opus-5-5" } },
      { id: "boss", engine: { provider: codex.instanceId, model: "gpt-5-codex" } },
    ];

    // Mirrors GroupThreadLanding: the boss answers first, so its engine picks the catalog.
    const boss = resolveAvailableGroupBoss(members, "boss");
    const selection = resolveStickyBotEngine({
      engine: boss?.engine ?? null,
      instanceEntries,
      settings: DEFAULT_UNIFIED_SETTINGS,
      providers,
      defaultSelection: { instanceId: claude.instanceId, model: "claude-opus-5-5" },
    });
    const catalog = botEngineCatalog(selection, instanceEntries);

    expect(catalog?.provider).toBe("codex");
    expect(catalog?.skills.map((skill) => skill.name)).toEqual(["ship"]);
    expect(catalog?.slashCommands.map((command) => command.name)).toEqual(["status"]);
  });
});
