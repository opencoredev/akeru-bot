import {
  joinProviderUnavailability,
  presentProviderUnavailability,
  providerAvailabilityReason,
  type ProviderAvailabilityPresentation,
  type ProviderAvailabilityReason,
  type ProviderAvailabilityTranslate,
} from "@akeru/client-runtime/provider-availability";
import { type ProviderInstanceEntry } from "./instanceTypes";

/**
 * Whether an instance can currently contribute models to an interactive picker.
 *
 * Disabling an instance updates `enabled` independently, while its previous
 * `ready` probe status can remain in the streamed snapshot until reconciliation.
 */
export function isProviderInstancePickerReady(entry: ProviderInstanceEntry): boolean {
  return entry.enabled && entry.isAvailable && entry.status === "ready";
}

/**
 * Whether an instance can expose its known models in the picker.
 *
 * A warning or error probe does not erase the server's model inventory. The
 * user can still pick one of those models and retry the provider, matching the
 * mobile client. Missing installs, login failures, and limits remain
 * unavailable.
 */
export function isProviderInstancePickerSelectable(entry: ProviderInstanceEntry): boolean {
  return (
    entry.enabled &&
    entry.isAvailable &&
    entry.installed &&
    entry.status !== "disabled" &&
    providerInstancePickerBlockReason(entry) === null
  );
}

/**
 * Keep a turned-off instance visible when it still has known models, so a
 * saved choice can show why its rows are disabled.
 */
export function isProviderInstancePickerVisible(entry: ProviderInstanceEntry): boolean {
  return entry.enabled || entry.models.length > 0;
}

/**
 * Why an instance (and optionally one of its models) cannot run a turn. A
 * missing entry means the saved instance no longer exists. Settings can turn
 * an instance off before the server snapshot catches up, so the entry's
 * `enabled` wins over the snapshot's.
 */
export function providerInstanceAvailabilityReason(
  entry: ProviderInstanceEntry | undefined,
  model?: string | null,
): ProviderAvailabilityReason | null {
  if (entry && !entry.enabled) return "disabled";

  return providerAvailabilityReason(entry?.snapshot, model);
}

/**
 * The inline message for an instance that cannot run a turn: title, one next
 * step, and which settings page fixes it. Null when the instance can run.
 */
export function providerInstanceUnavailability(
  entry: ProviderInstanceEntry | undefined,
  options: {
    readonly model?: string | null;
    readonly modelName?: string | null;
    readonly providerName?: string;
    readonly t?: ProviderAvailabilityTranslate | undefined;
  } = {},
): (ProviderAvailabilityPresentation & { readonly reason: ProviderAvailabilityReason }) | null {
  const reason = providerInstanceAvailabilityReason(entry, options.model);

  if (!reason) return null;

  return {
    reason,
    ...presentProviderUnavailability(
      {
        reason,
        providerName: entry?.displayName ?? options.providerName,
        modelName: options.modelName ?? options.model,
        detail: entry?.snapshot.unavailabilityDetail ?? entry?.snapshot.message,
      },
      options.t,
    ),
  };
}

/** `providerInstanceUnavailability` as one sentence for a disabled row or button. */
export function providerInstanceUnavailableReason(
  entry: ProviderInstanceEntry | undefined,
  options: {
    readonly model?: string | null;
    readonly modelName?: string | null;
    readonly providerName?: string;
    readonly t?: ProviderAvailabilityTranslate | undefined;
  } = {},
): string | null {
  const presentation = providerInstanceUnavailability(entry, options);

  return presentation ? joinProviderUnavailability(presentation, options.t) : null;
}

/**
 * Whether a picker row for this instance accepts a click. A temporary failure
 * stays pickable because the next attempt may succeed; every other reason
 * needs the user to fix something first.
 */
export function providerInstancePickerBlockReason(
  entry: ProviderInstanceEntry,
  t?: ProviderAvailabilityTranslate,
): string | null {
  const reason = providerInstanceAvailabilityReason(entry);

  if (!reason || reason === "temporary-failure") return null;

  return providerInstanceUnavailableReason(entry, { t });
}
