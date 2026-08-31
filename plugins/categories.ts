export const PLUGIN_CATEGORIES = [
  "Work",
  "Web",
  "Marketing",
  "Build",
  "Design",
  "Sales",
  "Support",
  "Commerce",
] as const;

export type CatalogCategory = (typeof PLUGIN_CATEGORIES)[number];

export type PluginCategory = CatalogCategory;

export const PLUGIN_APPROVAL_CLASSES = [
  "send",
  "pay",
  "delete",
  "production",
  "secrets",
  "publishing",
  "signatures",
  "refunds",
  "account-wide",
] as const;

export type PluginApprovalClass = (typeof PLUGIN_APPROVAL_CLASSES)[number];
