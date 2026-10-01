import { isJsonObject, decodeJson } from "../json.ts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { UsagePlanWindow } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { FETCH_TIMEOUT_MS, SESSION_MS, WEEK_MS } from "./usagePlanTypes.ts";

interface ParsedPlanUsage {
  readonly plan: string | null;
  readonly windows: readonly UsagePlanWindow[];
}

// @effect-diagnostics nodeBuiltinImport:off

export function asRecord(value: Schema.Json | undefined): Schema.JsonObject | null {
  return isJsonObject(value) ? value : null;
}

export function asNumber(value: Schema.Json | undefined): number | null {
  if (Predicate.isNumber(value) && Number.isFinite(value)) return value;

  if (Predicate.isString(value) && value.trim().length > 0) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function asString(value: Schema.Json | undefined): string | null {
  return Predicate.isString(value) && value.trim().length > 0 ? value.trim() : null;
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function isoFromUnknown(value: Schema.Json | undefined): string | null {
  const text = asString(value);

  if (text !== null) {
    const parsed = Date.parse(text);

    if (!Number.isNaN(parsed)) return DateTime.formatIso(DateTime.makeUnsafe(parsed));
    const numeric = asNumber(text);

    if (numeric !== null) return isoFromEpoch(numeric);

    return null;
  }

  const nested = asRecord(value);

  if (nested !== null) {
    return isoFromUnknown(nested.value ?? nested.seconds ?? nested.ms ?? nested.low);
  }

  const number = asNumber(value);

  return number === null ? null : isoFromEpoch(number);
}

/** Accepts epoch milliseconds or seconds (Codex often sends seconds). */
export function isoFromEpoch(value: number): string {
  const millis = Math.abs(value) < 1e11 ? value * 1000 : value;

  return DateTime.formatIso(DateTime.makeUnsafe(millis));
}

export function cycleEndFromUsage(root: Schema.JsonObject): string | null {
  const keys = [
    "billingCycleEnd",
    "billing_cycle_end",
    "periodEnd",
    "period_end",
    "nextResetAt",
    "nextResetTimestampUtc",
    "resetsAt",
    "resets_at",
  ];

  const bags = [root, asRecord(root.planUsage), asRecord(root.billingCycle), asRecord(root.usage)];

  for (const bag of bags) {
    if (bag === null) continue;

    for (const key of keys) {
      const iso = isoFromUnknown(bag[key]);

      if (iso !== null) return iso;
    }
  }

  return null;
}

export function windowFromDuration(durationMs: number | null): UsagePlanWindow["kind"] | null {
  if (durationMs === SESSION_MS) return "session";

  if (durationMs === WEEK_MS) return "weekly";

  return null;
}

export function parseClaudeUsage(body: Schema.Json): ParsedPlanUsage {
  const root = asRecord(body);

  if (root === null) return { plan: null, windows: [] };

  const windows: UsagePlanWindow[] = [];
  const fiveHour = parseClaudeWindow(root.five_hour ?? root.fiveHour, "session", "5-hour");
  const weekly = parseClaudeWindow(root.seven_day ?? root.sevenDay, "weekly", "Weekly");

  if (fiveHour) windows.push(fiveHour);

  if (weekly) windows.push(weekly);
  const sonnet = parseClaudeWindow(root.seven_day_sonnet ?? root.sevenDaySonnet, "model", "Sonnet");

  if (sonnet) windows.push(sonnet);

  const limits = Array.isArray(root.limits) ? root.limits : [];

  for (const entry of limits) {
    const object = asRecord(entry);

    if (object === null || object.kind !== "weekly_scoped") continue;
    const scope = asRecord(object.scope);
    const model = asRecord(scope?.model);
    const displayName = asString(model?.display_name);
    const used = asNumber(object.percent);

    if (displayName === null || used === null) continue;
    windows.push({
      kind: "model",
      label: displayName,
      usedPercent: clampPercent(used),
      resetsAt: isoFromUnknown(object.resets_at),
    });
  }

  return { plan: null, windows };
}

export function parseClaudeWindow(
  value: Schema.Json | undefined,
  kind: UsagePlanWindow["kind"],
  label: string,
): UsagePlanWindow | null {
  const object = asRecord(value);

  if (object === null) return null;

  const used =
    asNumber(object.utilization) ??
    asNumber(object.used_percent) ??
    asNumber(object.percent) ??
    asNumber(asRecord(object.utilization)?.used) ??
    asNumber(asRecord(object.utilization)?.percentage);

  if (used === null) return null;

  return {
    kind,
    label,
    usedPercent: clampPercent(used),
    resetsAt: isoFromUnknown(object.resets_at),
  };
}

export function parseCodexUsage(
  body: Schema.Json,
  headerPercents?: { readonly primary?: number; readonly secondary?: number },
): ParsedPlanUsage {
  const root = asRecord(body);

  if (root === null) return { plan: null, windows: [] };

  const rateLimit = asRecord(root.rate_limit);

  const windows = classifyCodexWindows(
    rateLimit,
    { session: "5-hour", weekly: "Weekly" },
    headerPercents,
  );

  const additional = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : [];

  for (const entry of additional) {
    const object = asRecord(entry);

    if (object === null) continue;

    const name =
      `${asString(object.limit_name) ?? ""} ${asString(object.metered_feature) ?? ""}`.toLowerCase();

    if (!name.includes("spark")) continue;
    windows.push(
      ...classifyCodexWindows(asRecord(object.rate_limit), {
        session: "Spark 5-hour",
        weekly: "Spark weekly",
      }),
    );
  }

  return { plan: formatCodexPlan(root.plan_type), windows };
}

export function classifyCodexWindows(
  rateLimit: Schema.JsonObject | null,
  labels: { readonly session: string; readonly weekly: string },
  headerPercents?: { readonly primary?: number; readonly secondary?: number },
): UsagePlanWindow[] {
  if (rateLimit === null) return [];

  const candidates = [
    codexCandidate(rateLimit.primary_window, headerPercents?.primary, "session"),
    codexCandidate(rateLimit.secondary_window, headerPercents?.secondary, "weekly"),
  ].filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

  const session = pickCodexWindow(candidates, "session", labels.session);
  const weekly = pickCodexWindow(candidates, "weekly", labels.weekly);

  return [session, weekly].filter((window): window is UsagePlanWindow => window !== null);
}

export function codexCandidate(
  value: Schema.Json | undefined,
  headerPercent: number | undefined,
  fallback: "session" | "weekly",
) {
  const window = asRecord(value) ?? (headerPercent === undefined ? null : {});

  if (window === null) return null;
  const usedPercent = asNumber(window.used_percent) ?? headerPercent ?? null;
  const durationMs = asNumber(window.limit_window_seconds);

  return {
    window,
    usedPercent,
    fallback,
    kind: windowFromDuration(durationMs === null ? null : durationMs * 1000),
  };
}

export function pickCodexWindow(
  candidates: readonly {
    readonly window: Schema.JsonObject;
    readonly usedPercent: number | null;
    readonly fallback: "session" | "weekly";
    readonly kind: UsagePlanWindow["kind"] | null;
  }[],
  kind: "session" | "weekly",
  label: string,
): UsagePlanWindow | null {
  const exact = candidates.find((candidate) => candidate.kind === kind);

  const fallback = candidates.find(
    (candidate) => candidate.kind === null && candidate.fallback === kind,
  );

  const candidate = exact ?? fallback;

  if (candidate === undefined || candidate.usedPercent === null) return null;

  const resetsAt =
    isoFromUnknown(candidate.window.reset_at) ??
    (() => {
      const after = asNumber(candidate.window.reset_after_seconds);

      return after === null
        ? null
        : DateTime.formatIso(DateTime.add(DateTime.nowUnsafe(), { seconds: after }));
    })();

  return {
    kind,
    label,
    usedPercent: clampPercent(candidate.usedPercent),
    resetsAt,
  };
}

export function formatCodexPlan(value: Schema.Json | undefined): string | null {
  const raw = asString(value);

  if (raw === null) return null;

  switch (raw.toLowerCase()) {
    case "prolite":
      return "Plus";
    case "pro":
      return "Pro";
    default:
      return raw;
  }
}

export function parseGrokUsage(body: Schema.Json): ParsedPlanUsage {
  const config = asRecord(asRecord(body)?.config);

  if (config === null) return { plan: null, windows: [] };
  const period = asRecord(config.currentPeriod);
  const periodType = asString(period?.type);
  const used = asNumber(config.creditUsagePercent) ?? 0;

  if (periodType !== "USAGE_PERIOD_TYPE_WEEKLY") return { plan: null, windows: [] };

  return {
    plan: null,
    windows: [
      {
        kind: "weekly",
        label: "Weekly",
        usedPercent: clampPercent(used),
        resetsAt: isoFromUnknown(period?.end),
      },
    ],
  };
}

export function parseKimiUsage(body: Schema.Json): ParsedPlanUsage {
  const root = asRecord(body);

  if (root === null) return { plan: null, windows: [] };
  const usage = asRecord(root.usage) ?? root;
  const windows: UsagePlanWindow[] = [];
  const session = asNumber(usage.rollingPercent) ?? asNumber(asRecord(usage.rolling)?.percent);
  const weekly = asNumber(usage.weeklyPercent) ?? asNumber(asRecord(usage.weekly)?.percent);

  if (session !== null) {
    windows.push({
      kind: "session",
      label: "5-hour",
      usedPercent: clampPercent(session),
      resetsAt: isoFromUnknown(asRecord(usage.rolling)?.resetsAt),
    });
  }

  if (weekly !== null) {
    windows.push({
      kind: "weekly",
      label: "Weekly",
      usedPercent: clampPercent(weekly),
      resetsAt: isoFromUnknown(asRecord(usage.weekly)?.resetsAt),
    });
  }

  return { plan: asString(root.plan) ?? asString(root.planName), windows };
}

export async function fetchJson(
  url: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Record<string, string>;
    readonly body?: string;
  },
): Promise<{ readonly status: number; readonly body: Schema.Json; readonly headers: Headers }> {
  const request = HttpClientRequest.make(init.method)(url, {
    headers: init.headers,
  }).pipe(
    init.body === undefined
      ? (request) => request
      : HttpClientRequest.bodyText(init.body, "application/json"),
  );

  const response = await Effect.runPromise(
    HttpClient.execute(request).pipe(
      Effect.timeout(Duration.millis(FETCH_TIMEOUT_MS)),
      Effect.provide(FetchHttpClient.layer),
    ),
  );

  let body: Schema.Json = null;

  try {
    body = decodeJson(await Effect.runPromise(response.json));
  } catch {
    body = null;
  }

  return {
    status: response.status,
    body,
    headers: new Headers(
      Object.entries(response.headers).flatMap(([key, value]) =>
        Predicate.isString(value) ? [[key, value]] : [],
      ),
    ),
  };
}
