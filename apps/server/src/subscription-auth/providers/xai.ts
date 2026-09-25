/**
 * xAI OAuth flow (Grok).
 *
 * Ported from Mastra Code (mastra-ai/mastra,
 * `mastracode/sdk/src/auth/providers/xai.ts`), Apache-2.0; originally ported
 * from pi-mono.
 *
 * Standard RFC 8628 device authorization grant: no inbound connection to this
 * server is needed. `startXAIDeviceLogin()` / `pollXAIDeviceLogin()` keep the
 * pending state JSON-serializable so polling can span RPC requests.
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type HttpClient, HttpClientRequest } from "effect/unstable/http";

import { createDeviceCodePollState, stepDeviceCodePoll } from "../deviceCode.ts";
import type { DeviceCodePollOutcome, DeviceCodePollState } from "../deviceCode.ts";
import {
  decodeOAuthBody,
  ensureOk,
  responseJson,
  responseText,
  runOAuthPromise,
  sendOAuthRequest,
  type SubscriptionAuthRequestError,
  SubscriptionAuthResponseError,
  withOAuthTimeout,
} from "../oauthHttp.ts";
import type { OAuthCredentials } from "../types.ts";

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_TOKEN_EXPIRES_IN_SECONDS = 3600;
const DEFAULT_DEVICE_CODE_EXPIRES_IN_SECONDS = 600;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT = "30 seconds";

const DeviceAuthorizationResponse = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.NonEmptyString,
  verification_uri_complete: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Number),
  expires_in: Schema.optional(Schema.Number),
});

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});

const TokenErrorBody = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.optional(Schema.String),
    interval: Schema.optional(Schema.Number),
  }),
);

const decodeTokenErrorBody = Schema.decodeUnknownOption(TokenErrorBody);

const postForm = (label: string, url: string, params: Record<string, string>) =>
  sendOAuthRequest(label, HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(params)));

/** The verification URI is opened by the user; only accept https URLs. */
function validateVerificationUri(raw: string): Effect.Effect<string, SubscriptionAuthResponseError> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return Effect.fail(
      new SubscriptionAuthResponseError({
        message: `xAI device authorization returned an invalid verification_uri: ${raw}`,
      }),
    );
  }
  if (parsed.protocol !== "https:") {
    return Effect.fail(
      new SubscriptionAuthResponseError({
        message: `xAI device authorization returned a non-https verification_uri: ${raw}`,
      }),
    );
  }
  return Effect.succeed(parsed.toString());
}

const credentialsFromTokenResponse = Effect.fn("xai.credentialsFromTokenResponse")(function* (
  body: unknown,
  previousRefreshToken?: string,
) {
  const tokens = yield* decodeOAuthBody(TokenResponse, "xAI token response missing access_token")(
    body,
  );
  // xAI may not rotate the refresh token on refresh; keep the previous one.
  const refresh = tokens.refresh_token || previousRefreshToken;
  if (!refresh) {
    return yield* new SubscriptionAuthResponseError({
      message: "xAI token response missing refresh_token",
    });
  }
  const expiresIn =
    tokens.expires_in !== undefined && tokens.expires_in > 0
      ? tokens.expires_in
      : DEFAULT_TOKEN_EXPIRES_IN_SECONDS;
  const now = yield* Clock.currentTimeMillis;
  return {
    access: tokens.access_token,
    refresh,
    expires: now + expiresIn * 1000 - REFRESH_SKEW_MS,
  } satisfies OAuthCredentials;
});

/** Serializable pending state for an xAI device-code login. */
export interface XAIDeviceLoginPending {
  deviceCode: string;
  userCode: string;
  /** Verification URL for the user to open (https-only, validated). */
  url: string;
  instructions: string;
  state: DeviceCodePollState;
}

export type XAIDevicePollResult =
  | { status: "complete"; credentials: OAuthCredentials }
  | { status: "pending"; nextPollMs: number; pending: XAIDeviceLoginPending }
  | { status: "failed"; error: string };

/** Start an xAI device-code login: request a user code and return pending state. */
const startDeviceLogin = Effect.fn("xai.startDeviceLogin")(function* () {
  const label = "Failed to initiate xAI device authorization";
  const data = yield* postForm(label, DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: SCOPE }).pipe(
    Effect.flatMap(ensureOk(label)),
    Effect.flatMap(responseJson),
    Effect.flatMap(
      decodeOAuthBody(
        DeviceAuthorizationResponse,
        "xAI device authorization response missing required fields",
      ),
    ),
    withOAuthTimeout("xAI device authorization", REQUEST_TIMEOUT),
  );
  const url = yield* validateVerificationUri(
    data.verification_uri_complete ?? data.verification_uri,
  );
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    url,
    instructions: `Enter code: ${data.user_code}`,
    state: createDeviceCodePollState({
      intervalSeconds: data.interval,
      expiresInSeconds:
        data.expires_in !== undefined && data.expires_in > 0
          ? data.expires_in
          : DEFAULT_DEVICE_CODE_EXPIRES_IN_SECONDS,
      now: yield* Clock.currentTimeMillis,
    }),
  } satisfies XAIDeviceLoginPending;
});

const pollTokenOnce = Effect.fn("xai.pollTokenOnce")(function* (
  pending: XAIDeviceLoginPending,
): Effect.fn.Return<
  DeviceCodePollOutcome<OAuthCredentials>,
  SubscriptionAuthRequestError,
  HttpClient.HttpClient
> {
  const response = yield* postForm("xAI device token poll", TOKEN_URL, {
    grant_type: DEVICE_CODE_GRANT_TYPE,
    device_code: pending.deviceCode,
    client_id: CLIENT_ID,
  });

  if (response.status >= 200 && response.status < 300) {
    return yield* responseJson(response).pipe(
      Effect.flatMap((body) => credentialsFromTokenResponse(body)),
      Effect.map((result): DeviceCodePollOutcome<OAuthCredentials> => ({
        status: "complete",
        result,
      })),
      Effect.catchTag("SubscriptionAuthResponseError", (error) =>
        Effect.succeed<DeviceCodePollOutcome<OAuthCredentials>>({
          status: "failed",
          error: error.message,
        }),
      ),
    );
  }

  const text = yield* responseText(response);
  const body = Option.getOrElse(decodeTokenErrorBody(text), () => ({
    error: undefined,
    interval: undefined,
  }));
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending", intervalSeconds: body.interval };
    case "slow_down":
      return { status: "slow_down", intervalSeconds: body.interval };
    case "access_denied":
    case "authorization_denied":
      return { status: "failed", error: "xAI authorization was denied" };
    case "expired_token":
      return { status: "failed", error: "xAI device code expired before authorization completed" };
    default:
      return {
        status: "failed",
        error: `xAI device authorization failed: ${response.status}${text ? ` ${text}` : ""}`,
      };
  }
}, withOAuthTimeout("xAI device token poll", REQUEST_TIMEOUT));

/**
 * Perform exactly one upstream poll for a pending xAI device login.
 * Returns the updated pending state so callers can persist slow_down interval
 * growth between polls. Flow-level conditions resolve as `failed`.
 */
const pollDeviceLogin = Effect.fn("xai.pollDeviceLogin")(function* (
  pending: XAIDeviceLoginPending,
) {
  const step = yield* stepDeviceCodePoll(pending.state, pollTokenOnce(pending));
  switch (step.status) {
    case "complete":
      return { status: "complete", credentials: step.result } satisfies XAIDevicePollResult;
    case "failed":
      return { status: "failed", error: step.error } satisfies XAIDevicePollResult;
    case "pending":
    case "slow_down":
      return {
        status: "pending",
        nextPollMs: step.nextPollMs,
        pending: { ...pending, state: step.state },
      } satisfies XAIDevicePollResult;
  }
});

/** Refresh an xAI OAuth token. */
const refreshToken = Effect.fn("xai.refreshToken")(function* (refresh: string) {
  const label = "xAI token refresh failed";
  return yield* postForm(label, TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refresh,
  }).pipe(
    Effect.flatMap(ensureOk(label)),
    Effect.flatMap(responseJson),
    Effect.flatMap((body) => credentialsFromTokenResponse(body, refresh)),
    withOAuthTimeout("xAI token refresh", REQUEST_TIMEOUT),
  );
});

/** Effect API for the xAI flow; requires an `HttpClient`. */
export const XAIOAuth = { startDeviceLogin, pollDeviceLogin, pollTokenOnce, refreshToken } as const;

export function startXAIDeviceLogin(options?: {
  signal?: AbortSignal;
}): Promise<XAIDeviceLoginPending> {
  return runOAuthPromise(startDeviceLogin(), options?.signal);
}

export function pollXAIDeviceLogin(
  pending: XAIDeviceLoginPending,
  options?: { signal?: AbortSignal },
): Promise<XAIDevicePollResult> {
  return runOAuthPromise(pollDeviceLogin(pending), options?.signal);
}

export function refreshXAIToken(refresh: string, signal?: AbortSignal): Promise<OAuthCredentials> {
  return runOAuthPromise(refreshToken(refresh), signal);
}
