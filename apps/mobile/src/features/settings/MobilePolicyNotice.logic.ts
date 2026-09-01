import { AKERU_PRIVACY_POLICY_VERSION, AKERU_TERMS_VERSION } from "@t3tools/contracts/settings";

export function needsMobilePolicyAcknowledgement(preferences: {
  readonly reviewedPrivacyPolicyVersion?: string;
  readonly reviewedTermsVersion?: string;
}): boolean {
  return (
    preferences.reviewedPrivacyPolicyVersion !== AKERU_PRIVACY_POLICY_VERSION ||
    preferences.reviewedTermsVersion !== AKERU_TERMS_VERSION
  );
}

export function shouldShowMobilePolicyNotice(input: {
  readonly appVariant: string;
  readonly loaded: boolean;
  readonly needsAcknowledgement: boolean;
}): boolean {
  return input.loaded && input.appVariant !== "development" && input.needsAcknowledgement;
}
