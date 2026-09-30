/**
 * Per-bot usage presentation.
 *
 * Pure mapping from the `bot.usage` query view to the rows and notices the
 * mobile screen renders, so every state (loading, failed, empty, partial, and
 * unavailable) is testable without a renderer.
 *
 * Semantics follow web's `BotUsageSection.tsx`: a measurement with unavailable
 * entries and no counted tokens reads "Unavailable", one with both reads as a
 * lower bound, and an estimate is never shown as subscription spend.
 *
 * @module features/usage/botUsagePresentation
 */
import type { AkeruBotUsageSnapshot } from "@akeru/contracts";

export type UsageMeasurement = AkeruBotUsageSnapshot["measurements"]["input"];

/** A label/value pair. `unavailable` drives the muted treatment on screen. */
export interface BotUsageRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly caption?: string;
  readonly unavailable: boolean;
}

export type BotUsageView =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly rows: ReadonlyArray<BotUsageRow>;
      /** Set when at least one provider measurement is incomplete. */
      readonly partialNotice: string | null;
    };

/**
 * A measurement is only a number when nothing is missing. Missing entries turn
 * it into a lower bound, and a measurement with nothing counted stays
 * unavailable rather than reading as zero.
 */
export function formatUsageMeasurement(measurement: UsageMeasurement): string {
  if (measurement.unavailableEntries === 0) return measurement.tokens.toLocaleString();
  return measurement.tokens === 0 ? "Unavailable" : `${measurement.tokens.toLocaleString()}+`;
}

export function isMeasurementUnavailable(measurement: UsageMeasurement): boolean {
  return measurement.unavailableEntries > 0;
}

function measurementRow(key: string, label: string, measurement: UsageMeasurement): BotUsageRow {
  return {
    key,
    label,
    value: formatUsageMeasurement(measurement),
    unavailable: isMeasurementUnavailable(measurement),
  };
}

export function formatEstimatedCost(cost: AkeruBotUsageSnapshot["estimatedCost"]): string {
  return cost.status === "available"
    ? `$${cost.usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "Unavailable";
}

/**
 * The server reports either a counted pool or a provider percentage. A percent
 * meter reads "34% of pool" rather than "34 / 100 percent", which invites the
 * number to be read as tokens.
 */
export function formatSubscriptionPool(pool: AkeruBotUsageSnapshot["subscriptionPool"]): string {
  if (pool.status === "unavailable") return "Unavailable";
  if (pool.unit === "percent") return `${pool.used.toLocaleString()}% of pool`;
  return `${pool.used.toLocaleString()} / ${pool.limit.toLocaleString()} ${pool.unit}`;
}

export function formatUsageCap(snapshot: AkeruBotUsageSnapshot): string {
  return snapshot.usageCap === null
    ? "No cap"
    : `${snapshot.consumedTokens.toLocaleString()} / ${snapshot.usageCap.limit.toLocaleString()} ${snapshot.usageCap.unit}`;
}

/** Where the cap is changed. Mobile has no bot editor; chat settings owns it. */
export const BOT_USAGE_CAP_EDIT_CAPTION =
  "Change the cap in a chat with this bot, under chat settings.";
export const BOT_USAGE_COST_CAPTION =
  "Estimated from model rates. Not subscription spend, and not an amount billed.";
export const BOT_USAGE_PARTIAL_NOTICE = "Some provider usage is unavailable.";

export function buildBotUsageRows(snapshot: AkeruBotUsageSnapshot): ReadonlyArray<BotUsageRow> {
  const rows: Array<BotUsageRow> = [
    measurementRow("input", "Input", snapshot.measurements.input),
    measurementRow("output", "Output", snapshot.measurements.output),
    measurementRow("observer", "Observer", snapshot.measurements.observer),
    measurementRow("reflector", "Reflector", snapshot.measurements.reflector),
    {
      key: "cap",
      label: "Cap",
      value: formatUsageCap(snapshot),
      caption: BOT_USAGE_CAP_EDIT_CAPTION,
      unavailable: false,
    },
    {
      key: "estimated-cost",
      label: "Estimated cost",
      value: formatEstimatedCost(snapshot.estimatedCost),
      caption: BOT_USAGE_COST_CAPTION,
      unavailable: snapshot.estimatedCost.status === "unavailable",
    },
    {
      key: "subscription-pool",
      label: "Subscription pool",
      value: formatSubscriptionPool(snapshot.subscriptionPool),
      unavailable: snapshot.subscriptionPool.status === "unavailable",
    },
  ];
  // Nothing reserved is not a measurement worth a row, and web hides it too.
  if (snapshot.reservedTokens > 0) {
    rows.push({
      key: "reserved",
      label: "Reserved",
      value: snapshot.reservedTokens.toLocaleString(),
      unavailable: false,
    });
  }
  return rows;
}

/**
 * Failure wins over stale data: a snapshot that could not be refreshed must not
 * read as current. Otherwise a snapshot renders, and its absence separates
 * "still loading" from "nothing recorded yet".
 */
export function botUsageView(query: {
  readonly data: AkeruBotUsageSnapshot | null;
  readonly error: string | null;
  readonly isPending: boolean;
}): BotUsageView {
  if (query.error !== null) return { kind: "error", message: "Usage unavailable" };
  if (query.data === null) {
    return query.isPending ? { kind: "loading" } : { kind: "empty", message: "No usage" };
  }
  const snapshot = query.data;
  const hasUnavailable = Object.values(snapshot.measurements).some((measurement) =>
    isMeasurementUnavailable(measurement),
  );
  return {
    kind: "ready",
    rows: buildBotUsageRows(snapshot),
    partialNotice: hasUnavailable ? BOT_USAGE_PARTIAL_NOTICE : null,
  };
}
