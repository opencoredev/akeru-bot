import * as NodeCrypto from "node:crypto";
import {
  USAGE_3H_COUNTER_KEYS,
  USAGE_3H_COUNTER_MAX,
  type Usage3hEvent as Usage3hEventType,
  type UsageAnalyticsProvider,
  type UsageArchitecture,
  type UsageClientType,
  type UsageOperatingSystem,
  type UsageSandboxProvider,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";

export const BUCKET_HOURS = 3;

export const BUCKET_MS = BUCKET_HOURS * 60 * 60 * 1_000;

export interface BucketAggregateRow {
  readonly botsCreated: number;
  readonly botsDeleted: number;
  readonly botsRestored: number;
  readonly botsTotalCreated: number;
  readonly botsTotalGone: number;
  readonly userMessages: number;
  readonly botReplies: number;
  readonly failedTurns: number;
  readonly groupMessages: number;
  readonly approvalsRequested: number;
  readonly approvalsAccepted: number;
  readonly approvalsRejected: number;
  readonly clientSurfaces: string | null;
  readonly providers: string | null;
  readonly sandboxes: string | null;
}

export interface TurnUsageRow {
  readonly provider: string | null;
  readonly sandbox: string | null;
  readonly count: number;
}

export interface ToolUsageRow {
  readonly itemType: string | null;
  readonly provider: string | null;
  readonly count: number;
}

export interface EnabledPluginRow {
  readonly pluginId: string;
}

export function bucketStartAt(timestamp: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(Math.floor(timestamp / BUCKET_MS) * BUCKET_MS));
}

export function bucketEnd(bucketStart: string): string {
  return DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe(bucketStart), { hours: BUCKET_HOURS }),
  );
}

export function clampCounter(value: number): number {
  return Math.min(USAGE_3H_COUNTER_MAX, Math.max(0, Math.floor(value)));
}

export function collapse<T extends string>(
  encoded: string | null,
  allowed: ReadonlySet<string>,
  normalize: (value: string) => T,
  none: T,
  mixed: T,
): T {
  const values = new Set(
    (encoded ?? "")
      .split(",")
      .filter(Boolean)
      .map((value) => (allowed.has(value) ? normalize(value) : normalize("other"))),
  );

  if (values.size === 0) return none;

  if (values.size > 1) return mixed;

  return values.values().next().value ?? none;
}

export // Retired providers such as Cursor fall through to "other" so historical
// buckets still match the event schema.
const providerValues = new Set(["codex", "claude", "claudeagent", "grok", "kimi", "opencode"]);

export function normalizeProvider(value: string): UsageAnalyticsProvider {
  if (value === "claudeagent") return "claude";

  if (value === "other") return "other";

  return providerValues.has(value) ? (value as UsageAnalyticsProvider) : "other";
}

export const sandboxValues = new Set([
  "none",
  "local",
  "e2b",
  "daytona",
  "vercel",
  "upstash",
  "ascii",
  "railway",
  "tenki",
]);

export function normalizeSandbox(value: string): UsageSandboxProvider {
  if (value === "other") return "other";

  return sandboxValues.has(value) ? (value as UsageSandboxProvider) : "other";
}

export const clientValues = new Set(["web", "desktop", "mobile"]);

export function normalizeClient(value: string): UsageClientType {
  if (value === "other") return "none";

  return clientValues.has(value) ? (value as UsageClientType) : "none";
}

export function operatingSystem(value: string): UsageOperatingSystem {
  return value === "darwin" || value === "linux" || value === "win32" ? value : "other";
}

export function architecture(value: string): UsageArchitecture {
  return value === "x64" || value === "arm64" || value === "arm" || value === "ia32"
    ? value
    : "other";
}

export function insertId(installationId: string, start: string): string {
  return NodeCrypto.createHash("sha256").update(`${installationId}:${start}`).digest("hex");
}

export function hasActivity(properties: Usage3hEventType["properties"]): boolean {
  return USAGE_3H_COUNTER_KEYS.some(
    (key) => key !== "bots_total" && !key.startsWith("plugin_enabled_") && properties[key] > 0,
  );
}
