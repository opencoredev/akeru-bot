import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";

import { privacyControlPatch, resolveSettingsEnvironmentId } from "./SettingsRouteScreen.logic";

describe("privacyControlPatch", () => {
  it.each([
    ["analytics", true, { analyticsEnabled: true }],
    ["analytics", false, { analyticsEnabled: false }],
    ["product-feedback", true, { productFeedbackEnabled: true }],
    ["product-feedback", false, { productFeedbackEnabled: false }],
    ["voice", true, { voice: { enabled: true } }],
    ["voice", false, { voice: { enabled: false } }],
    ["provider-update-checks", true, { enableProviderUpdateChecks: true }],
    ["provider-update-checks", false, { enableProviderUpdateChecks: false }],
  ] as const)("maps %s to its server settings patch", (control, enabled, expected) => {
    expect(privacyControlPatch(control, enabled)).toEqual(expected);
  });
});

describe("resolveSettingsEnvironmentId", () => {
  const first = EnvironmentId.make("server-a");
  const second = EnvironmentId.make("server-b");

  it("uses the selected environment when several are saved", () => {
    expect(resolveSettingsEnvironmentId(second, [first, second])).toBe(second);
  });

  it("does not guess when several environments are saved", () => {
    expect(resolveSettingsEnvironmentId(null, [first, second])).toBeNull();
  });

  it("uses the only saved environment when no selection is available", () => {
    expect(resolveSettingsEnvironmentId(null, [first])).toBe(first);
  });
});
