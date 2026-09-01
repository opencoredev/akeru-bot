import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const USAGE_3H_COUNTER_MAX = 1_000_000;
export const USAGE_BASE_COUNTER_KEYS = [
  "new_installations",
  "bots_created",
  "bots_deleted",
  "bots_total",
  "user_messages",
  "bot_replies",
  "failed_turns",
  "group_messages",
  "external_messages",
  "voice_sessions",
  "browser_tasks",
  "routines_run",
  "routine_failures",
  "connector_calls",
  "connector_failures",
  "approvals_requested",
  "approvals_accepted",
  "approvals_rejected",
] as const;

export const USAGE_PROVIDER_IDS = [
  "codex",
  "claude",
  "cursor",
  "grok",
  "kimi",
  "opencode",
  "other",
] as const;

export const USAGE_SANDBOX_IDS = [
  "none",
  "local",
  "vercel",
  "akeru_cloud",
  "upstash",
  "other",
] as const;

export const USAGE_TOOL_IDS = [
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "dynamic_tool_call",
  "collab_agent_tool_call",
  "web_search",
  "image_view",
] as const;

export const USAGE_BROWSER_PROVIDER_IDS = USAGE_PROVIDER_IDS;

// Public catalog slugs only. Unknown and custom MCP servers never leave the installation.
export const USAGE_PLUGIN_IDS = [
  "ahrefs",
  "apify",
  "apollo",
  "asana",
  "atlassian",
  "attio",
  "canva",
  "cloudflare",
  "coda",
  "context",
  "customer_io",
  "datadog",
  "docusign",
  "dropbox",
  "exa",
  "executor",
  "figma",
  "firecrawl",
  "framer",
  "github",
  "help_scout",
  "hubspot",
  "intercom",
  "lemon_squeezy",
  "linear",
  "mobbin",
  "monday",
  "netlify",
  "notion",
  "paddle",
  "paper",
  "parallel_search",
  "paypal",
  "pipedrive",
  "posthog",
  "railway",
  "render",
  "salesforce",
  "semrush",
  "sentry",
  "sequenzy",
  "shopify",
  "slack",
  "stripe",
  "superside",
  "tavily",
  "typefully",
  "vercel",
  "webflow",
  "zendesk",
  "zernio",
] as const;

export const USAGE_PROVIDER_COUNTER_KEYS = USAGE_PROVIDER_IDS.map(
  (id) => `provider_turns_${id}` as const,
);
export const USAGE_SANDBOX_COUNTER_KEYS = USAGE_SANDBOX_IDS.map(
  (id) => `sandbox_turns_${id}` as const,
);
export const USAGE_TOOL_COUNTER_KEYS = USAGE_TOOL_IDS.map((id) => `tool_calls_${id}` as const);
export const USAGE_BROWSER_PROVIDER_COUNTER_KEYS = USAGE_BROWSER_PROVIDER_IDS.map(
  (id) => `browser_searches_${id}` as const,
);
export const USAGE_PLUGIN_COUNTER_KEYS = USAGE_PLUGIN_IDS.map(
  (id) => `plugin_enabled_${id}` as const,
);
export const USAGE_3H_COUNTER_KEYS = [
  ...USAGE_BASE_COUNTER_KEYS,
  ...USAGE_PROVIDER_COUNTER_KEYS,
  ...USAGE_SANDBOX_COUNTER_KEYS,
  ...USAGE_TOOL_COUNTER_KEYS,
  ...USAGE_BROWSER_PROVIDER_COUNTER_KEYS,
  ...USAGE_PLUGIN_COUNTER_KEYS,
] as const;
export type UsageCounterKey = (typeof USAGE_3H_COUNTER_KEYS)[number];

const UsageCounter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: USAGE_3H_COUNTER_MAX }),
);
const AppVersion = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/,
  ),
);
const ThreeHourUtcBucket = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T(?:00|03|06|09|12|15|18|21):00:00\.000Z$/),
);
const InsertId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const UsageOperatingSystem = Schema.Literals(["darwin", "linux", "win32", "other"]);
export type UsageOperatingSystem = typeof UsageOperatingSystem.Type;

export const UsageArchitecture = Schema.Literals(["x64", "arm64", "arm", "ia32", "other"]);
export type UsageArchitecture = typeof UsageArchitecture.Type;

export const UsageClientType = Schema.Literals(["none", "web", "desktop", "mobile", "mixed"]);
export type UsageClientType = typeof UsageClientType.Type;

export const UsageAnalyticsProvider = Schema.Literals([
  "none",
  "codex",
  "claude",
  "cursor",
  "grok",
  "kimi",
  "opencode",
  "mixed",
  "other",
]);
export type UsageAnalyticsProvider = typeof UsageAnalyticsProvider.Type;

export const UsageSandboxProvider = Schema.Literals([
  "none",
  "local",
  "vercel",
  "akeru-cloud",
  "upstash",
  "mixed",
  "other",
]);
export type UsageSandboxProvider = typeof UsageSandboxProvider.Type;

const UsageCounters = Schema.Struct({
  ...Object.fromEntries(USAGE_3H_COUNTER_KEYS.map((key) => [key, UsageCounter])),
  new_installations: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
});

export const Usage3hProperties = Schema.Struct({
  app_version: AppVersion,
  operating_system: UsageOperatingSystem,
  architecture: UsageArchitecture,
  client_type: UsageClientType,
  provider: UsageAnalyticsProvider,
  sandbox_provider: UsageSandboxProvider,
  bucket_start: ThreeHourUtcBucket,
  ...UsageCounters.fields,
  $process_person_profile: Schema.Literal(false),
  $geoip_disable: Schema.Literal(true),
  $ip: Schema.Literal("0.0.0.0"),
  $insert_id: InsertId,
});
export type Usage3hProperties = typeof Usage3hProperties.Type &
  Readonly<Record<UsageCounterKey, number>>;

export const Usage3hEvent = Schema.Struct({
  event: Schema.Literal("usage_3h"),
  distinct_id: Schema.String.check(Schema.isUUID()),
  properties: Usage3hProperties,
  timestamp: Schema.String,
}).check(
  Schema.makeFilter(
    ({ properties, timestamp }) => {
      const bucketStart = DateTime.make(properties.bucket_start);
      return (
        Option.isSome(bucketStart) &&
        DateTime.formatIso(bucketStart.value) === properties.bucket_start &&
        DateTime.formatIso(DateTime.add(bucketStart.value, { hours: 3 })) === timestamp
      );
    },
    {
      expected: "timestamp at the close of bucket_start",
    },
  ),
);
export type Usage3hEvent = Omit<typeof Usage3hEvent.Type, "properties"> & {
  readonly properties: Usage3hProperties;
};

const decodeUsage3hEventUnknown = Schema.decodeUnknownSync(Usage3hEvent, {
  onExcessProperty: "error",
});

export function decodeUsage3hEvent(input: unknown): Usage3hEvent {
  return decodeUsage3hEventUnknown(input) as Usage3hEvent;
}
