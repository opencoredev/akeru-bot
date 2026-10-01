import type { PluginApprovalClass, CatalogCategory, } from "./categories.ts";

export const PLUGIN_SCHEMA_VERSION = 1 as const;

export type PluginPlatform = "web" | "desktop" | "mobile" | "macos" | "windows" | "linux";
export type PluginAuthentication = "none" | "oauth" | "optional-oauth" | "api-key";
export type PluginCatalogStatus = "available" | "approval-pending" | "verification-pending" | "deprecated";

export interface Party {
  readonly name: string;
  readonly url: string;
}

export interface PluginLogoManifest {
  readonly url?: string;
  readonly provenance: { readonly sourceUrl: string; readonly license: string };
}

export type PluginTransport =
  | { readonly type: "url"; readonly url: string }
  | { readonly type: "stdio"; readonly command: string; readonly args?: readonly string[] }
  | { readonly type: "unavailable" };

export type PluginConnection =
  | { readonly type: "ready" }
  | { readonly type: "api-key" }
  | { readonly type: "local" }
  | {
      readonly type: "brokered";
      readonly broker: Party;
      readonly pendingBlocker?: string;
    }
  | { readonly type: "approval-pending"; readonly blocker: string }
  | { readonly type: "verification-pending"; readonly blocker: string };

export interface PluginSkill {
  readonly title: string;
  readonly description: string;
  readonly url: string;
}

export interface PluginPermission {
  readonly id: string;
  readonly description: string;
  readonly approval: "read" | PluginApprovalClass;
}

export interface PluginManifest {
  readonly schemaVersion: typeof PLUGIN_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly primaryCategory: CatalogCategory;
  readonly tags: readonly string[];
  readonly capabilities: readonly string[];
  readonly featuredRank?: number;
  readonly publisher: Party;
  readonly maintainer: Party;
  readonly documentationUrl: string;
  readonly sourceUrl: string;
  readonly license: string;
  readonly logo: PluginLogoManifest;
  readonly platforms: readonly PluginPlatform[];
  readonly transport: PluginTransport;
  readonly connection: PluginConnection;
  readonly authentication: PluginAuthentication;
  readonly requiredCredentials: readonly string[];
  readonly setup: readonly string[];
  readonly permissions: readonly PluginPermission[];
  readonly approvals: readonly PluginApprovalClass[];
  readonly catalogStatus: PluginCatalogStatus;
  readonly skills?: readonly PluginSkill[];
}
