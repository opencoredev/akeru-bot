import { SETTINGS_DEEP_LINK_IDS } from "@t3tools/client-runtime/settings-deep-link";
import { describe, expect, it } from "vite-plus/test";

import { parseSettingsDeepLink } from "./settingsDeepLink";
import { SETTINGS_SECTIONS } from "./settingsDialogStore";

describe("settings deep links", () => {
  it.each([
    ["general", "general", null, "General"],
    ["local-execution", "general", "local-execution", "General > Local execution"],
    ["appearance", "appearance", null, "Appearance"],
    ["keybindings", "keybindings", null, "Keybindings"],
    ["providers", "providers", null, "Providers"],
    ["channels", "channels", null, "Bot channels"],
    ["voice", "voice", null, "Voice"],
    ["browser", "browser", null, "Browser"],
    ["plugins", "plugins", null, "Plugins"],
    ["sandbox", "sandbox", null, "Sandbox"],
    ["privacy", "privacy", null, "Privacy"],
    ["connections", "connections", null, "Connections"],
    ["source-control", "source-control", null, "Source control"],
    ["bot-inbox", "inbox", null, "Bot inbox"],
    ["diagnostics", "diagnostics", null, "Diagnostics"],
  ] as const)("maps %s to %s and target %s", (id, section, targetId, label) => {
    expect(parseSettingsDeepLink(`grokbot://app/v1/settings?id=${id}`)).toEqual({
      section,
      targetId,
      label,
    });
  });

  it("maps every shared id", () => {
    for (const id of SETTINGS_DEEP_LINK_IDS) {
      expect(parseSettingsDeepLink(`grokbot://app/v1/settings?id=${id}`), id).not.toBeNull();
    }
  });

  it("reaches every Settings section", () => {
    const reached = new Set(
      SETTINGS_DEEP_LINK_IDS.map(
        (id) => parseSettingsDeepLink(`grokbot://app/v1/settings?id=${id}`)?.section,
      ),
    );
    expect([...SETTINGS_SECTIONS].filter((section) => !reached.has(section))).toEqual([]);
  });

  it("uses General for a bare Settings link", () => {
    expect(parseSettingsDeepLink("grokbot://app/v1/settings")).toMatchObject({
      section: "general",
      targetId: null,
    });
    expect(parseSettingsDeepLink("grokbot://app/v1/settings?id=")).toMatchObject({
      section: "general",
    });
  });

  it.each([
    ["missing href", undefined],
    ["unparseable href", "not a url"],
    ["wrong scheme", "https://app/v1/settings?id=providers"],
    ["lookalike scheme", "grokbots://app/v1/settings?id=providers"],
    ["wrong host", "grokbot://evil/v1/settings?id=providers"],
    ["wrong path", "grokbot://app/v1/not-settings?id=providers"],
    ["wrong version", "grokbot://app/v2/settings?id=providers"],
    ["trailing slash", "grokbot://app/v1/settings/?id=providers"],
    ["fragment", "grokbot://app/v1/settings?id=providers#access"],
    ["duplicate id", "grokbot://app/v1/settings?id=providers&id=general"],
    ["extra query key", "grokbot://app/v1/settings?id=providers&from=chat"],
    ["only an extra key", "grokbot://app/v1/settings?from=chat"],
    ["unknown id", "grokbot://app/v1/settings?id=unknown"],
    ["removed access matrix", "grokbot://app/v1/settings?id=provider-access"],
    ["section name instead of id", "grokbot://app/v1/settings?id=inbox"],
  ])("rejects %s", (_label, href) => {
    expect(parseSettingsDeepLink(href)).toBeNull();
  });
});
