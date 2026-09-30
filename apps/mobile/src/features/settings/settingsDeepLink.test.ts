import { SETTINGS_DEEP_LINK_IDS } from "@t3tools/client-runtime/settings-deep-link";
import { describe, expect, it } from "vite-plus/test";

import { resolveMobileSettingsDestination } from "./settingsDeepLink";

describe("mobile Settings chat links", () => {
  it.each(["local-execution", "bot-inbox", "providers", "image-generation"] as const)(
    "opens the %s health target",
    (target) => {
      expect(resolveMobileSettingsDestination(`grokbot://app/v1/settings?id=${target}`)).toEqual({
        kind: "health",
        target,
      });
    },
  );

  it.each([
    ["appearance", "SettingsAppearance"],
    ["connections", "SettingsEnvironments"],
    ["archived-chats", "SettingsArchive"],
  ] as const)("opens %s on its mobile screen", (id, screen) => {
    expect(resolveMobileSettingsDestination(`grokbot://app/v1/settings?id=${id}`)).toEqual({
      kind: "screen",
      screen,
    });
  });

  it("falls back to the Settings home for ids without a mobile screen", () => {
    for (const id of ["general", "channels", "voice", "browser", "privacy", "diagnostics"]) {
      expect(resolveMobileSettingsDestination(`grokbot://app/v1/settings?id=${id}`), id).toEqual({
        kind: "home",
      });
    }
  });

  it("resolves every shared id", () => {
    for (const id of SETTINGS_DEEP_LINK_IDS) {
      expect(
        resolveMobileSettingsDestination(`grokbot://app/v1/settings?id=${id}`),
        id,
      ).not.toBeNull();
    }
  });

  it.each([
    "grokbot://app/v1/settings?id=providers&id=bot-inbox",
    "grokbot://app/v1/settings?id=provider-access",
    "grokbot://app/v1/settings?id=provider-access&from=chat",
    "grokbot://app/v1/settings?id=providers#health",
    "grokbot://other/v1/settings?id=providers",
    "https://app/v1/settings?id=providers",
  ])("rejects unsupported or malformed destination %s", (href) => {
    expect(resolveMobileSettingsDestination(href)).toBeNull();
  });
});
