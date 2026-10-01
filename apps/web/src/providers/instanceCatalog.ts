import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  resolveProviderInstanceEnabled,
  type ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@akeru/contracts";
import { formatProviderDriverKindLabel } from "../providerModels";
import { type ProviderInstanceEntry } from "./instanceTypes";

/**
 * Turn an instance id slug into a human-readable label. Splits on `_` / `-`
 * and camelCase boundaries and title-cases each token, so `codex_personal`
 * becomes "Codex Personal" and `myCustomInstance` becomes "My Custom
 * Instance".
 *
 * This is a fallback used only when the wire snapshot's `displayName`
 * doesn't disambiguate a non-default instance from the default one of the
 * same driver (today every built-in driver hard-codes a single presentation
 * label per kind, so two instances of the same kind arrive with identical
 * display names). When a server/driver later plumbs the user's configured
 * `ProviderInstanceConfig.displayName` through to the snapshot, that value
 * will take precedence over this fallback.
 */
function humanizeInstanceId(instanceId: ProviderInstanceId): string {
  const words: string[] = [];

  for (const token of instanceId
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")) {
    if (token.length === 0) continue;
    words.push(token.charAt(0).toUpperCase() + token.slice(1));
  }

  return words.join(" ");
}

function driverKindLabel(driverKind: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[driverKind] ?? formatProviderDriverKindLabel(driverKind);
}

/**
 * Whether an instance's icon carries the account badge: accent color set, or
 * several instances sharing a driver so the brand glyph alone is ambiguous.
 * Shared by the composer trigger, the picker rail, and sidebar rows.
 */
export function shouldShowInstanceBadge(
  entry: ProviderInstanceEntry,
  entries: Iterable<ProviderInstanceEntry>,
): boolean {
  if (entry.accentColor) return true;
  let sharedDriverCount = 0;

  for (const candidate of entries) {
    if (candidate.driverKind === entry.driverKind && ++sharedDriverCount > 1) return true;
  }

  return false;
}

export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  if (!trimmed) return undefined;

  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

/**
 * Resolve an entry's displayName with a tiered priority:
 *
 *   1. A snapshot `displayName` that differs from the driver-kind label —
 *      the server has explicitly named this instance, trust it.
 *   2. For non-default instances, a humanized `instanceId` — the server
 *      fell back to the driver-level presentation constant (which is the
 *      same for every instance of that kind), so we differentiate at the
 *      UI layer by slug. This is what keeps "Codex" + "Codex Personal"
 *      distinguishable in tooltips and list labels today.
 *   3. The snapshot's `displayName` (if any) — default instance, trust
 *      whatever label the driver stamped.
 *   4. `driverKindLabel(driverKind)` — nothing else on hand, so use the
 *      canonical brand label from contracts (falling back to a generic
 *      title-case of the kind slug).
 */
function resolveInstanceDisplayName(
  snapshot: ServerProvider,
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  isDefault: boolean,
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim();
  const kindLabel = driverKindLabel(driverKind);

  if (trimmedSnapshotName && trimmedSnapshotName !== kindLabel) {
    return trimmedSnapshotName;
  }

  if (!isDefault) {
    const humanized = humanizeInstanceId(instanceId);

    if (humanized.length > 0) return humanized;
  }

  return trimmedSnapshotName || kindLabel;
}

/**
 * Project the wire `ServerProvider[]` into instance entries, one per
 * configured instance. Preserves the server's ordering (which sources
 * from `deriveProviderInstanceConfigMap` — explicit `providerInstances.*`
 * first, synthesized defaults after) so callers that want "default first"
 * should sort with `sortProviderInstanceEntries` below.
 */
export function deriveProviderInstanceEntries(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceEntry> {
  return providers.map((snapshot) => {
    const instanceId = snapshot.instanceId;
    const driverKind = snapshot.driver;
    const defaultId = defaultInstanceIdForDriver(driverKind);
    const isDefault = instanceId === defaultId;
    const displayName = resolveInstanceDisplayName(snapshot, instanceId, driverKind, isDefault);

    return {
      instanceId,
      driverKind,
      displayName,
      accentColor: normalizeProviderAccentColor(snapshot.accentColor),
      continuationGroupKey: snapshot.continuation?.groupKey,
      enabled: snapshot.enabled,
      installed: snapshot.installed,
      status: snapshot.status,
      isDefault,
      isAvailable: snapshot.availability !== "unavailable",
      snapshot,
      models: snapshot.models,
    } satisfies ProviderInstanceEntry;
  });
}

/**
 * Project several environments' `ServerProvider[]` into a nested
 * `environmentId → instanceId → entry` lookup.
 *
 * Instance ids are per-environment routing keys, and `defaultInstanceIdForDriver`
 * makes the default id literally the driver slug, so every environment running
 * the same driver reports the same id. Flattening across environments would
 * clobber entries and mis-resolve accent colors; lookups must stay scoped to
 * the thread's own environment.
 */
export function deriveProviderEntriesByEnvironment(
  providersByEnvironment: Iterable<readonly [string, ReadonlyArray<ServerProvider>]>,
): ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>> {
  const byEnvironment = new Map<string, ReadonlyMap<string, ProviderInstanceEntry>>();

  for (const [environmentId, providers] of providersByEnvironment) {
    byEnvironment.set(
      environmentId,
      new Map(
        deriveProviderInstanceEntries(providers).map((entry) => [entry.instanceId, entry] as const),
      ),
    );
  }

  return byEnvironment;
}

/**
 * Overlay the current settings configuration onto streamed provider snapshots.
 * Provider probes can briefly retain their previous `enabled` value after a
 * settings write, so picker visibility must follow settings rather than waiting
 * for probe reconciliation.
 *
 * Non-default instances only exist through `providerInstances`; if one is
 * absent there, its streamed snapshot is stale (for example immediately after
 * deletion) and is treated as disabled.
 */
export function applyProviderInstanceSettings(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  settings: Pick<ServerSettings, "providerInstances" | "providers">,
): ReadonlyArray<ProviderInstanceEntry> {
  const legacyProviders = new Map(Object.entries(settings.providers));

  return entries.map((entry) => {
    const explicitInstance = settings.providerInstances?.[entry.instanceId];

    const enabled = explicitInstance
      ? resolveProviderInstanceEnabled(explicitInstance)
      : entry.isDefault
        ? (legacyProviders.get(entry.driverKind)?.enabled ?? entry.enabled)
        : false;

    return enabled === entry.enabled ? entry : { ...entry, enabled };
  });
}

/**
 * Sort instance entries so the default instance of each driver kind appears
 * before any custom instances of the same kind. Within a kind, custom
 * instances keep their settings-author order (which is how the server
 * emits them). Stable across kinds: entries retain the server's
 * cross-driver ordering.
 */
export function sortProviderInstanceEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  // Group by driver kind preserving first-appearance order, then emit
  // default-first within each kind. Using a Map keeps the "first-seen"
  // semantics for kinds whose default instance is absent (unusual but
  // possible during the migration).
  const byKind = new Map<ProviderDriverKind, ProviderInstanceEntry[]>();

  for (const entry of entries) {
    const bucket = byKind.get(entry.driverKind);

    if (bucket) {
      bucket.push(entry);
    } else {
      byKind.set(entry.driverKind, [entry]);
    }
  }

  const sorted: ProviderInstanceEntry[] = [];

  for (const bucket of byKind.values()) {
    const defaults = bucket.filter((entry) => entry.isDefault);
    const customs = bucket.filter((entry) => !entry.isDefault);
    sorted.push(...defaults, ...customs);
  }

  return sorted;
}
