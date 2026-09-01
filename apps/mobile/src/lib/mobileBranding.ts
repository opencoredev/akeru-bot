export type MobileStageLabel = "Alpha" | "Dev";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  return "Alpha";
}
