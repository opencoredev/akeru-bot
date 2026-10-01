// @effect-diagnostics globalFetch:off nodeBuiltinImport:off

export {
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCommandAction,
  type ProviderMaintenanceCapabilityResolutionOptions,
  type ProviderMaintenanceCapabilitiesResolver,
  type PackageManagedProviderMaintenanceDefinition,
  makeProviderMaintenanceCapabilities,
  makeManualOnlyProviderMaintenanceCapabilities,
  hasPathSeparator,
  normalizeCommandPath,
  resolvePackageManagedProviderMaintenance,
  makePackageManagedProviderMaintenanceResolver,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "./maintenance/ProviderMaintenanceCapabilities.ts";

export {
  type ProviderVersionCacheEntry,
  ProviderVersionCache,
  createProviderVersionAdvisory,
  resolveLatestProviderVersion,
  enrichProviderSnapshotWithVersionAdvisory,
} from "./maintenance/ProviderVersionAdvisory.ts";
