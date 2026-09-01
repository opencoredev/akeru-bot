import type { EnvironmentId } from "@t3tools/contracts";

export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "iOS only" };
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
