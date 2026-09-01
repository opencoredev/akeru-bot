import type { EnvironmentId, ServerSettingsPatch } from "@t3tools/contracts";

export type PrivacyControl = "analytics" | "product-feedback" | "voice" | "provider-update-checks";

export function privacyControlPatch(
  control: PrivacyControl,
  enabled: boolean,
): ServerSettingsPatch {
  switch (control) {
    case "analytics":
      return { analyticsEnabled: enabled };
    case "product-feedback":
      return { productFeedbackEnabled: enabled };
    case "voice":
      return { voice: { enabled } };
    case "provider-update-checks":
      return { enableProviderUpdateChecks: enabled };
  }
}

export function resolveSettingsEnvironmentId(
  selectedEnvironmentId: EnvironmentId | null | undefined,
  availableEnvironmentIds: ReadonlyArray<EnvironmentId>,
): EnvironmentId | null {
  if (
    selectedEnvironmentId !== null &&
    selectedEnvironmentId !== undefined &&
    availableEnvironmentIds.includes(selectedEnvironmentId)
  ) {
    return selectedEnvironmentId;
  }
  return availableEnvironmentIds.length === 1 ? (availableEnvironmentIds[0] ?? null) : null;
}
