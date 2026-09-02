// @effect-diagnostics globalFetch:off globalDate:off
/**
 * Live plan windows from Settings → Providers logins.
 *
 * Claude and Codex follow OpenUsage. Cursor uses the dashboard Connect RPC.
 * Grok uses the CLI billing credits endpoint. Kimi is attempted last.
 *
 * @module usagePlanLimits
 */
import type {
  SubscriptionProviderId,
  UsagePlanWindow,
  UsageProviderPlanLimits,
} from "@t3tools/contracts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CURSOR_USAGE_URL =
  "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const KIMI_USAGE_URL = "https://www.kimi.com/api/coding/usage";

const FETCH_TIMEOUT_MS = 10_000;
const SESSION_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const PLAN_PROVIDER_ORDER: readonly SubscriptionProviderId[] = [
  "openai-codex",
  "anthropic",
  "cursor",
  "xai",
  "kimi-for-coding",
  "opencode-go",
];

export type GetAccessToken = (provider: SubscriptionProviderId) => Promise<string | undefined>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isoFromUnknown(value: unknown): string | null {
  const text = asString(value);
  if (text !== null) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
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

/** Cursor sends epoch milliseconds. Codex often sends seconds. */
function isoFromEpoch(value: number): string {
  const millis = Math.abs(value) < 1e11 ? value * 1000 : value;
  return new Date(millis).toISOString();
}

function cycleEndFromUsage(root: Record<string, unknown>): string | null {
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

function windowFromDuration(durationMs: number | null): UsagePlanWindow["kind"] | null {
  if (durationMs === SESSION_MS) return "session";
  if (durationMs === WEEK_MS) return "weekly";
  return null;
}

export function parseClaudeUsage(body: unknown): {
  readonly plan: string | null;
  readonly windows: readonly UsagePlanWindow[];
} {
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

function parseClaudeWindow(
  value: unknown,
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
  body: unknown,
  headerPercents?: { readonly primary?: number; readonly secondary?: number },
): {
  readonly plan: string | null;
  readonly windows: readonly UsagePlanWindow[];
} {
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

function classifyCodexWindows(
  rateLimit: Record<string, unknown> | null,
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

function codexCandidate(
  value: unknown,
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

function pickCodexWindow(
  candidates: readonly {
    readonly window: Record<string, unknown>;
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
      return after === null ? null : new Date(Date.now() + after * 1000).toISOString();
    })();
  return {
    kind,
    label,
    usedPercent: clampPercent(candidate.usedPercent),
    resetsAt,
  };
}

function formatCodexPlan(value: unknown): string | null {
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

export function parseCursorUsage(body: unknown): {
  readonly plan: string | null;
  readonly windows: readonly UsagePlanWindow[];
} {
  const root = asRecord(body);
  const usage = asRecord(root?.usage) ?? root;
  if (usage === null) return { plan: null, windows: [] };
  const planUsage =
    asRecord(usage.planUsage) ??
    (Array.isArray(usage.planUsage) ? asRecord(usage.planUsage[0]) : null);
  if (planUsage === null) {
    return { plan: asString(root?.planName) ?? asString(usage.planName), windows: [] };
  }

  const cycleEnd = cycleEndFromUsage(usage) ?? cycleEndFromUsage(root ?? {});

  const windows: UsagePlanWindow[] = [];
  const totalPercent =
    asNumber(planUsage.totalPercentUsed) ??
    (() => {
      const limit = asNumber(planUsage.limit);
      const remaining = asNumber(planUsage.remaining);
      const spend = asNumber(planUsage.totalSpend);
      if (limit === null || limit <= 0) return null;
      if (spend !== null) return (spend / limit) * 100;
      if (remaining !== null) return ((limit - remaining) / limit) * 100;
      return null;
    })();
  if (totalPercent !== null) {
    windows.push({
      kind: "weekly",
      label: "Plan",
      usedPercent: clampPercent(totalPercent),
      resetsAt: cycleEnd,
    });
  }
  const autoPercent = asNumber(planUsage.autoPercentUsed);
  if (autoPercent !== null) {
    windows.push({
      kind: "model",
      label: "Cursor models",
      usedPercent: clampPercent(autoPercent),
      resetsAt: cycleEnd,
    });
  }
  const apiPercent = asNumber(planUsage.apiPercentUsed);
  if (apiPercent !== null) {
    windows.push({
      kind: "model",
      label: "Other models",
      usedPercent: clampPercent(apiPercent),
      resetsAt: cycleEnd,
    });
  }
  return {
    plan: asString(root?.planName) ?? asString(usage.planName),
    windows,
  };
}

export function parseGrokUsage(body: unknown): {
  readonly plan: string | null;
  readonly windows: readonly UsagePlanWindow[];
} {
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

export function parseKimiUsage(body: unknown): {
  readonly plan: string | null;
  readonly windows: readonly UsagePlanWindow[];
} {
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

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown; readonly headers: Headers }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body, headers: response.headers };
}

async function fetchClaude(accessToken: string): Promise<UsageProviderPlanLimits | null> {
  const result = await fetchJson(CLAUDE_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.1.69",
    },
  });
  if (result.status < 200 || result.status >= 300) return null;
  const parsed = parseClaudeUsage(result.body);
  if (parsed.windows.length === 0) return null;
  return {
    provider: "anthropic",
    status: "ok",
    plan: parsed.plan,
    message: null,
    windows: [...parsed.windows],
  };
}

async function fetchCodex(accessToken: string): Promise<UsageProviderPlanLimits | null> {
  const result = await fetchJson(CODEX_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": "Akeru Bot",
    },
  });
  if (result.status < 200 || result.status >= 300) return null;
  const primary = asNumber(result.headers.get("x-codex-primary-used-percent"));
  const secondary = asNumber(result.headers.get("x-codex-secondary-used-percent"));
  const parsed = parseCodexUsage(result.body, {
    ...(primary === null ? {} : { primary }),
    ...(secondary === null ? {} : { secondary }),
  });
  if (parsed.windows.length === 0) return null;
  return {
    provider: "openai-codex",
    status: "ok",
    plan: parsed.plan,
    message: null,
    windows: [...parsed.windows],
  };
}

async function fetchCursor(accessToken: string): Promise<UsageProviderPlanLimits | null> {
  const result = await fetchJson(CURSOR_USAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
  });
  if (result.status < 200 || result.status >= 300) return null;
  const parsed = parseCursorUsage(result.body);
  if (parsed.windows.length === 0) return null;
  return {
    provider: "cursor",
    status: "ok",
    plan: parsed.plan,
    message: null,
    windows: [...parsed.windows],
  };
}

async function fetchGrok(accessToken: string): Promise<UsageProviderPlanLimits | null> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    Accept: "application/json",
  };
  const [credits, settings] = await Promise.all([
    fetchJson(GROK_CREDITS_URL, { method: "GET", headers }),
    fetchJson(GROK_SETTINGS_URL, { method: "GET", headers }).catch(() => null),
  ]);
  if (credits.status < 200 || credits.status >= 300) return null;
  const parsed = parseGrokUsage(credits.body);
  if (parsed.windows.length === 0) return null;
  const plan =
    parsed.plan ??
    (settings && settings.status >= 200 && settings.status < 300
      ? asString(asRecord(settings.body)?.subscription_tier_display)
      : null);
  return {
    provider: "xai",
    status: "ok",
    plan,
    message: null,
    windows: [...parsed.windows],
  };
}

async function fetchKimi(accessToken: string): Promise<UsageProviderPlanLimits | null> {
  const result = await fetchJson(KIMI_USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (result.status < 200 || result.status >= 300) return null;
  const parsed = parseKimiUsage(result.body);
  if (parsed.windows.length === 0) return null;
  return {
    provider: "kimi-for-coding",
    status: "ok",
    plan: parsed.plan,
    message: null,
    windows: [...parsed.windows],
  };
}

async function fetchProvider(
  provider: SubscriptionProviderId,
  accessToken: string,
): Promise<UsageProviderPlanLimits | null> {
  switch (provider) {
    case "openai-codex":
      return fetchCodex(accessToken);
    case "anthropic":
      return fetchClaude(accessToken);
    case "cursor":
      return fetchCursor(accessToken);
    case "xai":
      return fetchGrok(accessToken);
    case "kimi-for-coding":
      return fetchKimi(accessToken);
    case "opencode-go":
      return null;
  }
}

const PLAN_LIMIT_TTL_MS = 5 * 60 * 1000;
const PLAN_LIMIT_FAILURE_BACKOFF_MS = 60 * 1000;

const planLimitCache = new Map<
  SubscriptionProviderId,
  { readonly limits: UsageProviderPlanLimits; readonly fetchedAt: number }
>();
const planLimitFailedAt = new Map<SubscriptionProviderId, number>();

export function resetPlanLimitCache(): void {
  planLimitCache.clear();
  planLimitFailedAt.clear();
}

function emptyConnectedLimits(provider: SubscriptionProviderId): UsageProviderPlanLimits {
  return {
    provider,
    status: "ok",
    plan: null,
    message: null,
    windows: [],
  };
}

async function readProviderPlanLimits(
  provider: SubscriptionProviderId,
  getAccessToken: GetAccessToken,
): Promise<UsageProviderPlanLimits | null> {
  const token = await getAccessToken(provider);
  if (token === undefined) return null;

  const now = Date.now();
  const cached = planLimitCache.get(provider);
  if (cached !== undefined && now - cached.fetchedAt < PLAN_LIMIT_TTL_MS) {
    return cached.limits;
  }
  const failedAt = planLimitFailedAt.get(provider);
  if (failedAt !== undefined && now - failedAt < PLAN_LIMIT_FAILURE_BACKOFF_MS) {
    return cached?.limits ?? emptyConnectedLimits(provider);
  }

  try {
    const fresh = await fetchProvider(provider, token);
    if (fresh !== null) {
      planLimitCache.set(provider, { limits: fresh, fetchedAt: now });
      planLimitFailedAt.delete(provider);
      return fresh;
    }
  } catch {
    // Keep the last good windows. Anthropic 429s this endpoint often.
  }
  planLimitFailedAt.set(provider, now);
  return cached?.limits ?? emptyConnectedLimits(provider);
}

export async function readPlanLimits(
  getAccessToken: GetAccessToken,
): Promise<readonly UsageProviderPlanLimits[]> {
  const results = await Promise.all(
    PLAN_PROVIDER_ORDER.map((provider) => readProviderPlanLimits(provider, getAccessToken)),
  );
  return results.filter((entry): entry is UsageProviderPlanLimits => entry !== null);
}
