import { describe, expect, it } from "@effect/vitest";

import {
  needsMobilePolicyAcknowledgement,
  shouldShowMobilePolicyNotice,
} from "./MobilePolicyNotice.logic";

describe("mobile policy notice", () => {
  it("requires the current local policy versions", () => {
    expect(needsMobilePolicyAcknowledgement({})).toBe(true);
    expect(
      needsMobilePolicyAcknowledgement({
        reviewedPrivacyPolicyVersion: "2026-08-31",
        reviewedTermsVersion: "2026-08-31",
      }),
    ).toBe(false);
    expect(
      needsMobilePolicyAcknowledgement({
        reviewedPrivacyPolicyVersion: "2026-08-31",
        reviewedTermsVersion: "older",
      }),
    ).toBe(true);
  });

  it("shows only after signed-build preferences load", () => {
    expect(
      shouldShowMobilePolicyNotice({
        appVariant: "production",
        loaded: true,
        needsAcknowledgement: true,
      }),
    ).toBe(true);
    expect(
      shouldShowMobilePolicyNotice({
        appVariant: "preview",
        loaded: true,
        needsAcknowledgement: true,
      }),
    ).toBe(true);
    expect(
      shouldShowMobilePolicyNotice({
        appVariant: "development",
        loaded: true,
        needsAcknowledgement: true,
      }),
    ).toBe(false);
    expect(
      shouldShowMobilePolicyNotice({
        appVariant: "production",
        loaded: false,
        needsAcknowledgement: true,
      }),
    ).toBe(false);
  });
});
