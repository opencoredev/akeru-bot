import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Akeru Cloud is an optional hosted service. An environment links to a cloud
 * account once, then keeps one outbound WebSocket to it. Everything that
 * crosses that socket is a `CloudEnvironmentMessage` or `CloudServerMessage`.
 * New features add message kinds and advertise a capability in `hello`
 * instead of opening another connection.
 */

export const CLOUD_PROTOCOL_VERSION = 1;

export const DEFAULT_AKERU_CLOUD_URL = "https://cloud.akeru-bot.com";

/** The developer cloud. Servers running from source in dev use it unless told otherwise. */
export const STAGING_AKERU_CLOUD_URL = "https://akeru-cloud-staging.leoisadev.workers.dev";

export const CLOUD_LINK_START_PATH = "/v1/link/start";

export const CLOUD_LINK_POLL_PATH = "/v1/link/poll";

export const CLOUD_ENVIRONMENT_SOCKET_PATH = "/v1/environments/connect";

/** Akeru Cloud origin. HTTPS, or plain HTTP only for a loopback development Worker. */
export const AkeruCloudUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(
    /^(?:https:\/\/[a-z0-9.-]+(?::\d+)?|http:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?)\/?$/i,
  ),
);

export type AkeruCloudUrl = typeof AkeruCloudUrl.Type;

const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

// RFC 5321 caps an address at 320 characters, longer than other short text.
const EmailText = TrimmedNonEmptyString.check(Schema.isMaxLength(320));

const OpaqueToken = TrimmedNonEmptyString.check(Schema.isMaxLength(512));

export const CloudEnvironmentId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("CloudEnvironmentId"),
);

export type CloudEnvironmentId = typeof CloudEnvironmentId.Type;

/** Public identifier baked into a hosted channel's inbound URL. Not a secret. */
export const CloudChannelRouteId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
).pipe(Schema.brand("CloudChannelRouteId"));

export type CloudChannelRouteId = typeof CloudChannelRouteId.Type;

/** Features an environment can use over the socket. Unknown values are ignored by older clouds. */
export const CloudCapability = Schema.Literals(["hosted-channels"]);

export type CloudCapability = typeof CloudCapability.Type;

/** Channel providers the cloud can relay for. Slack first; iMessage and others extend this list. */
export const CloudHostedChannelProvider = Schema.Literals(["slack"]);

export type CloudHostedChannelProvider = typeof CloudHostedChannelProvider.Type;

export const CloudAccount = Schema.Struct({
  email: EmailText,
});

export type CloudAccount = typeof CloudAccount.Type;

// ---------------------------------------------------------------------------
// Device link (HTTP). Works when the client and environment run on different machines:
// the environment starts the flow, the user approves in any browser.

export const CloudLinkStartRequest = Schema.Struct({
  environmentName: ShortText,
  serverVersion: ShortText,
});

export type CloudLinkStartRequest = typeof CloudLinkStartRequest.Type;

export const CloudLinkStartResponse = Schema.Struct({
  deviceCode: OpaqueToken,
  userCode: ShortText,
  verificationUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  expiresAt: IsoDateTime,
  pollIntervalSeconds: PositiveInt,
});

export type CloudLinkStartResponse = typeof CloudLinkStartResponse.Type;

export const CloudLinkPollRequest = Schema.Struct({
  deviceCode: OpaqueToken,
});

export type CloudLinkPollRequest = typeof CloudLinkPollRequest.Type;

export const CloudLinkPollResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({ status: Schema.Literal("expired") }),
  Schema.Struct({ status: Schema.Literal("denied") }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    environmentId: CloudEnvironmentId,
    /** Bearer credential for the socket. Stored only in the environment's secret store. */
    environmentToken: OpaqueToken,
    account: CloudAccount,
  }),
]);

export type CloudLinkPollResponse = typeof CloudLinkPollResponse.Type;

// ---------------------------------------------------------------------------
// Hosted channels. The cloud owns a public inbound URL per route and forwards raw
// requests to the owning environment. It never stores message content or channel
// secrets; the environment verifies signatures itself.

export const CloudChannelRoute = Schema.Struct({
  routeId: CloudChannelRouteId,
  provider: CloudHostedChannelProvider,
  /** Public URL the channel provider delivers events and interactions to. */
  inboundUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  /** Public URL the provider redirects OAuth installs to. */
  oauthRedirectUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
});

export type CloudChannelRoute = typeof CloudChannelRoute.Type;

export const CloudForwardedRequest = Schema.Struct({
  method: Schema.Literals(["GET", "POST"]),
  /** Path and query below the route's inbound URL. */
  path: Schema.String.check(Schema.isMaxLength(2_048)),
  headers: Schema.Record(Schema.String, Schema.String),
  /** The exact request body bytes, base64-encoded, so signatures verify over what the provider sent. */
  bodyBase64: Schema.String,
  receivedAt: IsoDateTime,
});

export type CloudForwardedRequest = typeof CloudForwardedRequest.Type;

/** Why an OAuth flow started. Each purpose decides who exchanges the code. */
export const CloudOAuthPurpose = Schema.Literals([
  /** Akeru's Slack manager app. The cloud owns its client secret and exchanges the code. */
  "slack.manager",
  /** A per-bot Slack app. The environment owns its client secret and exchanges the code. */
  "slack.install",
]);

export type CloudOAuthPurpose = typeof CloudOAuthPurpose.Type;

export const CloudOAuthResult = Schema.Union([
  Schema.Struct({
    purpose: Schema.Literal("slack.manager"),
    /** User token with `app_configurations:write`. Handed to the environment, never stored by the cloud. */
    accessToken: OpaqueToken,
    refreshToken: Schema.optionalKey(OpaqueToken),
    expiresInSeconds: Schema.optionalKey(PositiveInt),
    teamId: ShortText,
    teamName: ShortText,
    userId: ShortText,
  }),
  Schema.Struct({
    purpose: Schema.Literal("slack.install"),
    routeId: CloudChannelRouteId,
    code: OpaqueToken,
    redirectUri: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  }),
  Schema.Struct({
    purpose: CloudOAuthPurpose,
    error: ShortText,
  }),
]);

export type CloudOAuthResult = typeof CloudOAuthResult.Type;

// ---------------------------------------------------------------------------
// Socket protocol. Requests carry a `requestId`; the cloud answers each with `result`.

export const CloudRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const CloudEnvironmentMessage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("hello"),
    v: Schema.Literal(CLOUD_PROTOCOL_VERSION),
    serverVersion: ShortText,
    environmentName: ShortText,
    capabilities: Schema.Array(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("ping") }),
  Schema.Struct({
    kind: Schema.Literal("channel.route.create"),
    requestId: CloudRequestId,
    provider: CloudHostedChannelProvider,
    label: ShortText,
  }),
  Schema.Struct({
    kind: Schema.Literal("channel.route.update"),
    requestId: CloudRequestId,
    routeId: CloudChannelRouteId,
    label: Schema.optionalKey(ShortText),
    externalAppId: Schema.optionalKey(ShortText),
    externalWorkspaceId: Schema.optionalKey(ShortText),
    externalWorkspaceName: Schema.optionalKey(ShortText),
  }),
  Schema.Struct({
    kind: Schema.Literal("channel.route.delete"),
    requestId: CloudRequestId,
    routeId: CloudChannelRouteId,
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth.begin"),
    requestId: CloudRequestId,
    purpose: CloudOAuthPurpose,
    routeId: Schema.optionalKey(CloudChannelRouteId),
  }),
  /** Unlinks this environment from its account. The cloud answers `result`, then closes the socket. */
  Schema.Struct({
    kind: Schema.Literal("environment.unlink"),
    requestId: CloudRequestId,
  }),
]);

export type CloudEnvironmentMessage = typeof CloudEnvironmentMessage.Type;

export const CloudRequestResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("channel.route"), route: CloudChannelRoute }),
  Schema.Struct({ type: Schema.Literal("empty") }),
  Schema.Struct({
    type: Schema.Literal("oauth.begin"),
    flowId: ShortText,
    state: OpaqueToken,
    redirectUri: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
    /** Present when the cloud can build the authorize URL itself (it owns the client id). */
    authorizeUrl: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  }),
]);

export type CloudRequestResult = typeof CloudRequestResult.Type;

export const CloudErrorCode = Schema.Literals([
  "invalid-request",
  "not-found",
  "limit-reached",
  "disabled",
  "internal",
]);

export type CloudErrorCode = typeof CloudErrorCode.Type;

export const CloudServerMessage = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("welcome"),
    v: Schema.Literal(CLOUD_PROTOCOL_VERSION),
    environmentId: CloudEnvironmentId,
    account: CloudAccount,
    capabilities: Schema.Array(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("pong") }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    requestId: CloudRequestId,
    ok: Schema.Literal(true),
    value: CloudRequestResult,
  }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    requestId: CloudRequestId,
    ok: Schema.Literal(false),
    code: CloudErrorCode,
    message: Schema.String.check(Schema.isMaxLength(512)),
  }),
  Schema.Struct({
    kind: Schema.Literal("channel.inbound"),
    routeId: CloudChannelRouteId,
    provider: CloudHostedChannelProvider,
    request: CloudForwardedRequest,
  }),
  Schema.Struct({
    kind: Schema.Literal("channel.missed"),
    routeId: CloudChannelRouteId,
    provider: CloudHostedChannelProvider,
    count: NonNegativeInt,
    since: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("oauth.completed"),
    flowId: ShortText,
    result: CloudOAuthResult,
  }),
  /** The account revoked this environment. The environment forgets its token and stops reconnecting. */
  Schema.Struct({ kind: Schema.Literal("revoked") }),
]);

export type CloudServerMessage = typeof CloudServerMessage.Type;

// ---------------------------------------------------------------------------
// Environment-local status shown by clients. Never contains the environment token.

export const CloudLinkStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unlinked") }),
  Schema.Struct({
    status: Schema.Literal("linking"),
    userCode: ShortText,
    verificationUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("linked"),
    account: CloudAccount,
    environmentId: CloudEnvironmentId,
    connection: Schema.Literals(["connecting", "connected", "offline"]),
  }),
  Schema.Struct({ status: Schema.Literal("revoked") }),
]);

export type CloudLinkStatus = typeof CloudLinkStatus.Type;

/** Why a client-initiated link, cancel, or unlink failed. Messages are safe to show and never include credentials. */
export class CloudLinkError extends Schema.TaggedErrorClass<CloudLinkError>()("CloudLinkError", {
  reason: Schema.Literals(["already-linked", "unreachable", "invalid-response", "storage"]),
  message: Schema.String,
}) {}
