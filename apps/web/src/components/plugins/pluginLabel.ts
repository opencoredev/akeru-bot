import type { useI18n } from "../../i18n";

type Translate = ReturnType<typeof useI18n>["t"];

/**
 * Translates the fixed labels that `pluginPresentation` returns: filters,
 * categories, section titles, primary actions, and connection kinds. Any other
 * text (catalog data) passes through unchanged.
 */
export function pluginLabel(label: string, t: Translate): string {
  switch (label) {
    case "All":
      return t("All");
    case "Featured":
      return t("Featured");
    case "Installed":
      return t("Installed");
    case "Search results":
      return t("Search results");
    case "Work":
      return t("Work");
    case "Web":
      return t("Web");
    case "Marketing":
      return t("Marketing");
    case "Build":
      return t("Build");
    case "Design":
      return t("Design");
    case "Sales":
      return t("Sales");
    case "Support":
      return t("Support");
    case "Commerce":
      return t("Commerce");
    case "Add":
      return t("Add");
    case "Connect":
      return t("Connect");
    case "Add key":
      return t("Add key");
    case "Disable":
      return t("Disable");
    case "Reconnect":
      return t("Reconnect");
    case "Approval pending":
      return t("Approval pending");
    case "Verification pending":
      return t("Verification pending");
    case "Local":
      return t("Local");
    case "API key":
      return t("API key");
    case "No sign-in":
      return t("No sign-in");
    default:
      return label;
  }
}
