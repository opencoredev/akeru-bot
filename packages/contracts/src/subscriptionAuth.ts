/**
 * Subscription provider auth: bring-your-own-subscription login flows.
 *
 * A provider here is a consumer subscription (Claude Pro/Max, ChatGPT, Cursor,
 * X Premium, Kimi For Coding) connected over OAuth. Tokens never cross this
 * contract — the server holds them; clients only see connection status and
 * login-flow progress.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BotId, IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { McpServerId } from "./mcpServer.ts";

export const SubscriptionProviderId = Schema.Literals([
  "anthropic",
  "openai-codex",
  "cursor",
  "xai",
  "kimi-for-coding",
  "opencode-go",
]);
export type SubscriptionProviderId = typeof SubscriptionProviderId.Type;

export const SubscriptionAuthMode = Schema.Literals(["oauth", "api-key"]);
export type SubscriptionAuthMode = typeof SubscriptionAuthMode.Type;

export const SubscriptionBaseUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return (
          (url.protocol === "https:" || url.protocol === "http:") &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    },
    { message: "Use an HTTP or HTTPS base URL without credentials, a query, or a fragment." },
  ),
);

export const SubscriptionProviderStatus = Schema.Struct({
  provider: SubscriptionProviderId,
  connected: Schema.Boolean,
  authMode: Schema.optional(SubscriptionAuthMode),
  baseUrl: Schema.optional(SubscriptionBaseUrl),
  /** ms epoch when the current access token expires. Absent when disconnected. */
  expiresAt: Schema.optional(Schema.Number),
  health: Schema.optional(
    Schema.Literals([
      "missing",
      "detected",
      "healthy",
      "expired",
      "revoked",
      "failed",
      "unsupported",
      "disabled",
      "failed-first-request",
      "recovered",
    ]),
  ),
  lastSuccessfulRequestAt: Schema.optional(IsoDateTime),
  lastFailedRequest: Schema.optional(
    Schema.Struct({
      at: IsoDateTime,
      message: TrimmedNonEmptyString,
    }),
  ),
  nextRetryAt: Schema.optional(IsoDateTime),
  reconnectAction: Schema.optional(TrimmedNonEmptyString),
  healthTest: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(["not-run", "passed", "failed"]),
      checkedAt: Schema.optional(IsoDateTime),
    }),
  ),
  oauthCheck: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(["passed", "failed"]),
      checkedAt: IsoDateTime,
    }),
  ),
  dependentBots: Schema.Array(Schema.Struct({ id: BotId, name: TrimmedNonEmptyString })).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  dependentRoutines: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type SubscriptionProviderStatus = typeof SubscriptionProviderStatus.Type;

export const ProviderAccessStatus = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  accessMethod: Schema.Literals(["subscription-oauth", "api-key", "acp-cli", "browser", "mcp"]),
  health: Schema.Literals([
    "missing",
    "detected",
    "healthy",
    "expired",
    "revoked",
    "failed",
    "unsupported",
    "disabled",
    "failed-first-request",
    "recovered",
  ]),
  apiAccess: Schema.Literals(["separate", "included", "not-applicable"]),
  nextAction: TrimmedNonEmptyString,
  publishedLimit: Schema.optional(TrimmedNonEmptyString),
  temporary: Schema.optional(Schema.Boolean),
  repairAction: Schema.optional(TrimmedNonEmptyString),
  serverId: Schema.optional(TrimmedNonEmptyString),
  pluginId: Schema.optional(TrimmedNonEmptyString),
  lastSuccessfulRequestAt: Schema.optional(IsoDateTime),
  lastFailedRequest: Schema.optional(
    Schema.Struct({ at: IsoDateTime, message: TrimmedNonEmptyString }),
  ),
  nextRetryAt: Schema.optional(IsoDateTime),
  reconnectAction: Schema.optional(TrimmedNonEmptyString),
  dependentBots: Schema.Array(Schema.Struct({ id: BotId, name: TrimmedNonEmptyString })).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  dependentRoutines: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ProviderAccessStatus = typeof ProviderAccessStatus.Type;

export const BotInboxItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  incidentKey: TrimmedNonEmptyString,
  kind: Schema.Literals([
    "oauth-expired",
    "connector-failure",
    "routine-failure",
    "browser-dead",
    "silence-watchdog-failure",
    "approval-request",
  ]),
  status: Schema.Literals(["open", "resolved"]),
  botId: BotId,
  botName: TrimmedNonEmptyString,
  taskOrRoutine: TrimmedNonEmptyString,
  lastFailure: TrimmedNonEmptyString,
  nextAction: TrimmedNonEmptyString,
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  resolvedAt: Schema.optional(IsoDateTime),
  occurrenceCount: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type BotInboxItem = typeof BotInboxItem.Type;

export const BotInboxResolveInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type BotInboxResolveInput = typeof BotInboxResolveInput.Type;

export const SubscriptionAuthStatuses = Schema.Struct({
  providers: Schema.Array(SubscriptionProviderStatus),
  access: Schema.Array(ProviderAccessStatus).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  inbox: Schema.Array(BotInboxItem).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SubscriptionAuthStatuses = typeof SubscriptionAuthStatuses.Type;

export const SubscriptionAuthHealthTestInput = Schema.Struct({
  provider: SubscriptionProviderId,
});
export type SubscriptionAuthHealthTestInput = typeof SubscriptionAuthHealthTestInput.Type;

export const SubscriptionAuthStartInput = Schema.Struct({
  provider: SubscriptionProviderId,
  authMode: Schema.optional(SubscriptionAuthMode),
  /** Custom endpoints apply to API-key authentication only. */
  baseUrl: Schema.optional(SubscriptionBaseUrl),
});
export type SubscriptionAuthStartInput = typeof SubscriptionAuthStartInput.Type;

/**
 * A started login. `completion` says how it finishes: "poll" flows settle by
 * repeated `poll` calls; "paste" flows need the user to paste a code or key into
 * `complete`.
 */
export const SubscriptionAuthStartResult = Schema.Struct({
  loginId: Schema.String,
  provider: SubscriptionProviderId,
  url: Schema.String,
  userCode: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  completion: Schema.Literals(["poll", "paste"]),
});
export type SubscriptionAuthStartResult = typeof SubscriptionAuthStartResult.Type;

export const SubscriptionAuthPollInput = Schema.Struct({
  loginId: Schema.String,
});
export type SubscriptionAuthPollInput = typeof SubscriptionAuthPollInput.Type;

export const SubscriptionAuthCompleteInput = Schema.Struct({
  loginId: Schema.String,
  /** Pasted authorization input or API key. */
  code: Schema.String,
});
export type SubscriptionAuthCompleteInput = typeof SubscriptionAuthCompleteInput.Type;

export const SubscriptionAuthLoginProgress = Schema.Union([
  Schema.Struct({ status: Schema.Literal("connected") }),
  Schema.Struct({ status: Schema.Literal("pending"), nextPollMs: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
]);
export type SubscriptionAuthLoginProgress = typeof SubscriptionAuthLoginProgress.Type;

export const SubscriptionAuthLogoutInput = Schema.Struct({
  provider: SubscriptionProviderId,
});
export type SubscriptionAuthLogoutInput = typeof SubscriptionAuthLogoutInput.Type;

export class SubscriptionAuthError extends Schema.TaggedErrorClass<SubscriptionAuthError>()(
  "SubscriptionAuthError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const McpServerAuthenticateInput = Schema.Struct({
  mcpServerId: McpServerId,
});
export type McpServerAuthenticateInput = typeof McpServerAuthenticateInput.Type;

export const McpServerAuthenticationProgress = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("authorization-required"),
    authorizationUrl: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("connected"),
    toolCount: NonNegativeInt,
    recoveryFailures: Schema.Array(TrimmedNonEmptyString),
  }),
]);
export type McpServerAuthenticationProgress = typeof McpServerAuthenticationProgress.Type;

export class McpServerAuthenticationError extends Schema.TaggedErrorClass<McpServerAuthenticationError>()(
  "McpServerAuthenticationError",
  {
    mcpServerId: McpServerId,
    reason: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.reason;
  }
}
