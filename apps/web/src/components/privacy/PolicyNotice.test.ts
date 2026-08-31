import { describe, expect, it } from "vite-plus/test";

import { needsPolicyAcceptance, shouldShowPolicyNotice } from "./PolicyNotice";

describe("needsPolicyAcceptance", () => {
  it("requires each current local policy version", () => {
    expect(
      needsPolicyAcceptance({
        acceptedPrivacyPolicyVersion: "",
        acceptedTermsVersion: "",
      }),
    ).toBe(true);
    expect(
      needsPolicyAcceptance({
        acceptedPrivacyPolicyVersion: "2026-08-31",
        acceptedTermsVersion: "2026-08-31",
      }),
    ).toBe(false);
  });
});

describe("shouldShowPolicyNotice", () => {
  it("opens only for a hydrated packaged desktop build with outdated policies", () => {
    expect(
      shouldShowPolicyNotice({
        hydrated: true,
        isDesktop: true,
        isPackaged: true,
        needsAcceptance: true,
      }),
    ).toBe(true);

    for (const key of ["hydrated", "isDesktop", "isPackaged", "needsAcceptance"] as const) {
      expect(
        shouldShowPolicyNotice({
          hydrated: true,
          isDesktop: true,
          isPackaged: true,
          needsAcceptance: true,
          [key]: false,
        }),
      ).toBe(false);
    }
  });
});
