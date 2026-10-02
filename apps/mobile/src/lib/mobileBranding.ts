export type MobileStageLabel = "Alpha" | "Dev";

export function resolveMobileStageLabel(appVariant: string | undefined): MobileStageLabel {
  if (appVariant === "development") return "Dev";

  return "Alpha";
}
