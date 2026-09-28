/**
 * Live plan windows from Settings → Providers logins.
 *
 * Claude and Codex follow OpenUsage. Grok uses the CLI billing credits endpoint.
 * Kimi is attempted last.
 *
 * @module usagePlanLimits
 */
import type {
  SubscriptionProviderId,
  UsagePlanWindow,
  UsageProviderPlanLimits,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const KIMI_USAGE_URL = "https://www.kimi.com/api/coding/usage";

const FETCH_TIMEOUT_MS = 10_000;
const SESSION_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type LiveSubscriptionProviderId = Exclude<SubscriptionProviderId, "cursor">;

const PLAN_PROVIDER_ORDER: readonly LiveSubscriptionProviderId[] = [
  "openai-codex",
  "anthropic",
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

/** Codex often sends seconds; some providers send epoch milliseconds. */
function isoFromEpoch(value: number): string {
  const millis = Math.abs(value) < 1e11 ? value * 1000 : value;
  return DateTime.formatIso(DateTime.makeUnsafe(millis));
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
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Record<string, string>;
    readonly body?: string;
  },
): Promise<{ readonly status: number; readonly body: unknown; readonly headers: Headers }> {
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
  let body: unknown = null;
  try {
    body = await Effect.runPromise(response.json);
  } catch {
    body = null;
  }
  return {
    status: response.status,
    body,
    headers: new Headers(
      Object.entries(response.headers).filter(([, value]) => typeof value === "string") as [
        string,
        string,
      ][],
    ),
  };
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
  provider: LiveSubscriptionProviderId,
  accessToken: string,
): Promise<UsageProviderPlanLimits | null> {
  switch (provider) {
    case "openai-codex":
      return fetchCodex(accessToken);
    case "anthropic":
      return fetchClaude(accessToken);
    case "xai":
      return fetchGrok(accessToken);
    case "kimi-for-coding":
      return fetchKimi(accessToken);
    case "opencode-go":
      return null;
    default:
      return null;
  }
}

const PLAN_LIMIT_TTL = Duration.minutes(5);
// Failure backoff is the cache TTL: a failed or unavailable read keeps serving
// the last good windows and is not retried until this shorter expiry lapses.
const PLAN_LIMIT_FAILURE_BACKOFF = Duration.minutes(1);

type CachedPlanLimits = {
  readonly limits: UsageProviderPlanLimits;
  readonly fresh: boolean;
};

function makePlanLimitCache(getAccessToken: GetAccessToken) {
  const lastGoodPlanLimits = new Map<string, UsageProviderPlanLimits>();
  return Cache.makeWith<LiveSubscriptionProviderId, CachedPlanLimits | null>(
    (key) =>
      Effect.promise(async () => {
        const provider = key;
        try {
          const resolvedToken = await getAccessToken(provider);
          if (resolvedToken === undefined) return null;
          const fresh = await fetchProvider(provider, resolvedToken);
          if (fresh !== null) {
            lastGoodPlanLimits.set(key, fresh);
            return { limits: fresh, fresh: true };
          }
        } catch {
          // Keep the last good windows during provider failures.
        }
        return {
          limits: lastGoodPlanLimits.get(key) ?? emptyConnectedLimits(provider),
          fresh: false,
        };
      }),
    {
      capacity: PLAN_PROVIDER_ORDER.length * 2,
      timeToLive: (exit) =>
        exit._tag === "Success" && exit.value?.fresh ? PLAN_LIMIT_TTL : PLAN_LIMIT_FAILURE_BACKOFF,
    },
  );
}

function emptyConnectedLimits(provider: LiveSubscriptionProviderId): UsageProviderPlanLimits {
  return {
    provider,
    status: "ok",
    plan: null,
    message: null,
    windows: [],
  };
}

function readProviderPlanLimits(
  provider: LiveSubscriptionProviderId,
  cache: Cache.Cache<LiveSubscriptionProviderId, CachedPlanLimits | null>,
): Effect.Effect<UsageProviderPlanLimits | null> {
  return Cache.get(cache, provider).pipe(Effect.map((result) => result?.limits ?? null));
}

export function makePlanLimitsReader(getAccessToken: GetAccessToken) {
  return Effect.map(
    makePlanLimitCache(getAccessToken),
    (cache) => (provider?: SubscriptionProviderId) =>
      Effect.all(
        (provider === undefined
          ? PLAN_PROVIDER_ORDER
          : provider === "cursor"
            ? []
            : [provider]
        ).map((selected) => readProviderPlanLimits(selected, cache)),

        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((results) =>
          results.filter((entry): entry is UsageProviderPlanLimits => entry !== null),
        ),
      ),
  );
}

export function readPlanLimitsEffect(getAccessToken: GetAccessToken) {
  return Effect.flatMap(makePlanLimitsReader(getAccessToken), (read) => read());
}

export async function readPlanLimits(getAccessToken: GetAccessToken) {
  return Effect.runPromise(readPlanLimitsEffect(getAccessToken));
}
