import { describe, expect, it } from "vite-plus/test";

import { resolveMobileSettingsDestination } from "./settingsDeepLink";

describe("mobile Settings chat links", () => {
  it.each(["local-execution", "bot-inbox"] as const)("opens the %s target", (target) => {
    expect(resolveMobileSettingsDestination(`t3code://app/v1/settings?id=${target}`)).toEqual({
      kind: "health",
      target,
    });
  });

  it.each([
    ["general", { kind: "root" }],
    ["appearance", { kind: "screen", screen: "SettingsAppearance" }],
    ["connections", { kind: "screen", screen: "SettingsEnvironments" }],
  ] as const)("opens the supported %s screen", (id, destination) => {
    expect(resolveMobileSettingsDestination(`t3code://app/v1/settings?id=${id}`)).toEqual(
      destination,
    );
  });

  it.each([
    "t3code://app/v1/settings?id=providers",
    "t3code://app/v1/settings?id=provider-access",
    "t3code://app/v1/settings?id=provider-access&id=bot-inbox",
    "t3code://app/v1/settings?id=provider-access&from=chat",
    "t3code://app/v1/settings?id=provider-access#health",
    "t3code://other/v1/settings?id=provider-access",
  ])("rejects unsupported or malformed destination %s", (href) => {
    expect(resolveMobileSettingsDestination(href)).toBeNull();
  });
});
