import {
  type ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderState,
} from "@akeru/contracts";

/**
 * UI-facing projection of one configured provider instance. Carries the
 * snapshot verbatim for callers that need server-side fields we don't
 * hoist here, plus the precomputed `instanceId` / `driverKind` /
 * `displayName` used by every picker and settings view.
 */
export interface ProviderInstanceEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly continuationGroupKey?: string | undefined;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: ServerProviderState;
  /**
   * True when this entry is the default instance for its driver kind —
   * i.e. its instance id equals `defaultInstanceIdForDriver(driverKind)`.
   * The settings panel and picker sort defaults before customs.
   */
  readonly isDefault: boolean;
  /** True when `availability === "unavailable"` is absent or "available". */
  readonly isAvailable: boolean;
  readonly snapshot: ServerProvider;
  readonly models: ReadonlyArray<ServerProviderModel>;
}
