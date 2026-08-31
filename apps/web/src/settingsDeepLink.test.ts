import { describe, expect, it } from "vite-plus/test";

import { parseSettingsDeepLink } from "./settingsDeepLink";

describe("settings deep links", () => {
  it.each([
    ["general", "general", null],
    ["local-execution", "general", "local-execution"],
    ["bot-inbox", "inbox", null],
    ["appearance", "appearance", null],
    ["providers", "providers", null],
    ["voice", "voice", null],
    ["connections", "connections", null],
    ["keybindings", "keybindings", null],
    ["source-control", "source-control", null],
    ["diagnostics", "diagnostics", null],
  ] as const)("maps %s to %s and target %s", (id, section, targetId) => {
    expect(parseSettingsDeepLink(`t3code://app/v1/settings?id=${id}`)).toMatchObject({
      section,
      targetId,
    });
  });

  it("uses General for a bare Settings link", () => {
    expect(parseSettingsDeepLink("t3code-dev://app/v1/settings")).toMatchObject({
      section: "general",
      targetId: null,
    });
  });

  it("opens the error inbox and rejects the removed access matrix", () => {
    expect(parseSettingsDeepLink("t3code://app/v1/settings?id=provider-access")).toBeNull();
    expect(parseSettingsDeepLink("t3code://app/v1/settings?id=bot-inbox")).toMatchObject({
      section: "inbox",
      targetId: null,
      tooltip: "Open Settings > Errors",
    });
  });

  it("maps local execution and rejects external lookalikes", () => {
    expect(parseSettingsDeepLink("t3code://app/v1/settings?id=local-execution")).toMatchObject({
      section: "general",
      targetId: "local-execution",
      tooltip: "Open Settings > General > Local execution",
    });
    expect(parseSettingsDeepLink("https://app/v1/settings?id=providers")).toBeNull();
    expect(parseSettingsDeepLink("t3code://app/v1/not-settings?id=providers")).toBeNull();
    expect(parseSettingsDeepLink("t3code://app/v1/settings?id=unknown")).toBeNull();
    expect(parseSettingsDeepLink("t3code://user@app/v1/settings?id=providers")).toBeNull();
    expect(parseSettingsDeepLink("t3code://app:123/v1/settings?id=providers")).toBeNull();
    expect(parseSettingsDeepLink("t3code://app/v1/settings?id=providers&from=chat")).toBeNull();
    expect(parseSettingsDeepLink("t3code://app/v1/settings?id=providers&id=general")).toBeNull();
    expect(parseSettingsDeepLink("t3code://app/v1/settings?id=providers#access")).toBeNull();
  });
});
