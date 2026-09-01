import { describe, expect, it } from "vite-plus/test";

import { needsPolicyAcknowledgement, shouldShowPolicyNotice } from "./PolicyNotice";

describe("needsPolicyAcknowledgement", () => {
  it("requires each current local policy version", () => {
    expect(
      needsPolicyAcknowledgement({
        reviewedPrivacyPolicyVersion: "",
        reviewedTermsVersion: "",
      }),
    ).toBe(true);
    expect(
      needsPolicyAcknowledgement({
        reviewedPrivacyPolicyVersion: "2026-08-31",
        reviewedTermsVersion: "2026-08-31",
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
        needsAcknowledgement: true,
      }),
    ).toBe(true);

    for (const key of ["hydrated", "isDesktop", "isPackaged", "needsAcknowledgement"] as const) {
      expect(
        shouldShowPolicyNotice({
          hydrated: true,
          isDesktop: true,
          isPackaged: true,
          needsAcknowledgement: true,
          [key]: false,
        }),
      ).toBe(false);
    }
  });
});
