/**
 * Kimi For Coding OAuth flow (Moonshot).
 *
 * Ported from Mastra Code PR mastra-ai/mastra#22428
 * (`mastracode/sdk/src/auth/providers/kimi-coding.ts`), Apache-2.0.
 *
 * RFC 8628-style device flow against auth.kimi.com. Device metadata headers
 * identify the client; one device id follows the account through login and refresh.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { type HttpClient, HttpClientRequest } from "effect/unstable/http";

import { createDeviceCodePollState, stepDeviceCodePoll } from "../deviceCode.ts";
import type { DeviceCodePollOutcome, DeviceCodePollState } from "../deviceCode.ts";
import {
  decodeOAuthBody,
  ensureOk,
  responseJson,
  runOAuthPromise,
  sendOAuthRequest,
  SubscriptionAuthInputError,
  SubscriptionAuthRequestError,
  withOAuthTimeout,
} from "../oauthHttp.ts";
import type { OAuthCredentials } from "../types.ts";

const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const OAUTH_HOST = "https://auth.kimi.com";
const DEFAULT_EXPIRES_IN_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const REQUEST_TIMEOUT = "30 seconds";
const REFRESH_MAX_RETRIES = 3;

function asciiHeaderValue(value: string): string {
  const sanitized = value.replace(/[^\x20-\x7E]/g, "").trim();
  return sanitized || "unknown";
}

export function isKimiCodingDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function getKimiCodingDeviceHeaders(deviceId: string): Record<string, string> {
  if (!isKimiCodingDeviceId(deviceId)) throw new Error("Invalid Kimi For Coding device id");
  return {
    "X-Msh-Platform": "akeru",
    "X-Msh-Version": "0.0.34",
    "X-Msh-Device-Name": asciiHeaderValue(NodeOS.hostname()),
    "X-Msh-Device-Model": "Akeru server",
    "X-Msh-Os-Version": asciiHeaderValue(NodeOS.release()),
    "X-Msh-Device-Id": deviceId,
  };
}

/** Only https URLs are shown to the user. */
const HttpsUrl = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      return new URL(value).protocol === "https:" || "expected an https URL";
    } catch {
      return "expected an https URL";
    }
  }),
);

const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));

const DeviceAuthorizationResponse = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri: HttpsUrl,
  verification_uri_complete: HttpsUrl,
  interval: Schema.optional(Schema.Unknown),
  expires_in: Schema.optional(Schema.Unknown),
});

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: PositiveFinite,
});

const TokenErrorBody = Schema.Struct({
  error: Schema.optional(Schema.Unknown),
  error_description: Schema.optional(Schema.Unknown),
  interval: Schema.optional(Schema.Unknown),
});

const isPositiveFinite = Schema.is(PositiveFinite);
const isTokenErrorBody = Schema.is(TokenErrorBody);
const hasAccessToken = Schema.is(Schema.Struct({ access_token: Schema.String }));

const positiveOr = (value: unknown, fallback: number) =>
  isPositiveFinite(value) ? value : fallback;

const postToken = (label: string, deviceId: string, params: Record<string, string>) =>
  sendOAuthRequest(
    label,
    HttpClientRequest.post(`${OAUTH_HOST}/api/oauth/token`).pipe(
      HttpClientRequest.setHeaders(getKimiCodingDeviceHeaders(deviceId)),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyUrlParams({ client_id: CLIENT_ID, ...params }),
    ),
  );

const credentialsFromTokenResponse = Effect.fn("kimi.credentialsFromTokenResponse")(function* (
  body: unknown,
  operation: string,
  deviceId: string,
) {
  const tokens = yield* decodeOAuthBody(
    TokenResponse,
    `Kimi For Coding token ${operation} response missing fields`,
  )(body);
  const now = yield* Clock.currentTimeMillis;
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now + tokens.expires_in * 1000,
    deviceId,
  } satisfies OAuthCredentials;
});

export interface KimiDeviceLoginPending {
  deviceId: string;
  deviceCode: string;
  userCode: string;
  url: string;
  instructions: string;
  state: DeviceCodePollState;
}

export type KimiDevicePollResult =
  | { status: "complete"; credentials: OAuthCredentials }
  | { status: "pending"; nextPollMs: number; pending: KimiDeviceLoginPending }
  | { status: "failed"; error: string };

const startDeviceLogin = Effect.fn("kimi.startDeviceLogin")(function* () {
  const deviceId = NodeCrypto.randomUUID().replaceAll("-", "");
  const label = "Kimi For Coding device authorization failed";
  const data = yield* sendOAuthRequest(
    label,
    HttpClientRequest.post(`${OAUTH_HOST}/api/oauth/device_authorization`).pipe(
      HttpClientRequest.setHeaders(getKimiCodingDeviceHeaders(deviceId)),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyUrlParams({ client_id: CLIENT_ID }),
    ),
  ).pipe(
    Effect.flatMap(ensureOk(label)),
    Effect.flatMap(responseJson),
    Effect.flatMap(
      decodeOAuthBody(
        DeviceAuthorizationResponse,
        "Invalid Kimi For Coding device authorization response",
      ),
    ),
    withOAuthTimeout("Kimi For Coding device authorization", REQUEST_TIMEOUT),
  );
  return {
    deviceId,
    deviceCode: data.device_code,
    userCode: data.user_code,
    url: new URL(data.verification_uri_complete).href,
    instructions: `Enter code: ${data.user_code}`,
    state: createDeviceCodePollState({
      intervalSeconds: positiveOr(data.interval, DEFAULT_POLL_INTERVAL_SECONDS),
      expiresInSeconds: positiveOr(data.expires_in, DEFAULT_EXPIRES_IN_SECONDS),
      now: yield* Clock.currentTimeMillis,
    }),
  } satisfies KimiDeviceLoginPending;
});

const pollTokenOnce = Effect.fn("kimi.pollTokenOnce")(function* (
  pending: KimiDeviceLoginPending,
): Effect.fn.Return<
  DeviceCodePollOutcome<OAuthCredentials>,
  SubscriptionAuthRequestError,
  HttpClient.HttpClient
> {
  const response = yield* postToken("Kimi For Coding token request", pending.deviceId, {
    device_code: pending.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const body = yield* responseJson(response);
  const ok = response.status >= 200 && response.status < 300;
  if (ok && hasAccessToken(body)) {
    return yield* credentialsFromTokenResponse(body, "poll", pending.deviceId).pipe(
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

  const data = isTokenErrorBody(body) ? body : {};
  const error = data.error;
  if (error === "authorization_pending") return { status: "pending" };
  if (error === "slow_down") {
    return {
      status: "slow_down",
      intervalSeconds: isPositiveFinite(data.interval) ? data.interval : undefined,
    };
  }
  if (error === "expired_token") {
    return { status: "failed", error: "Kimi For Coding authorization expired. Restart the login." };
  }
  if (error === "access_denied") {
    return { status: "failed", error: "Kimi For Coding login was denied." };
  }
  const description =
    typeof data.error_description === "string" ? `: ${data.error_description}` : "";
  return {
    status: "failed",
    error: `Kimi For Coding token request failed: ${response.status}${
      typeof error === "string" ? ` ${error}${description}` : ""
    }`,
  };
}, withOAuthTimeout("Kimi For Coding token request", REQUEST_TIMEOUT));

const pollDeviceLogin = Effect.fn("kimi.pollDeviceLogin")(function* (
  pending: KimiDeviceLoginPending,
) {
  if (!isKimiCodingDeviceId(pending.deviceId)) {
    return {
      status: "failed",
      error: "Kimi For Coding login is missing its device identity. Restart the login.",
    } satisfies KimiDevicePollResult;
  }
  const step = yield* stepDeviceCodePoll(pending.state, pollTokenOnce(pending));
  switch (step.status) {
    case "complete":
      return { status: "complete", credentials: step.result } satisfies KimiDevicePollResult;
    case "failed":
      return { status: "failed", error: step.error } satisfies KimiDevicePollResult;
    case "pending":
    case "slow_down":
      return {
        status: "pending",
        nextPollMs: step.nextPollMs,
        pending: { ...pending, state: step.state },
      } satisfies KimiDevicePollResult;
  }
});

/** Transport failures, timeouts, 429, and 5xx retry after 1s, 2s, then 4s. */
const refreshRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.setInputType<SubscriptionAuthRequestError | { readonly retryable?: never }>(),
  Schedule.while(({ input, attempt }) => attempt <= REFRESH_MAX_RETRIES && input.retryable === true),
);

/** Refresh a Kimi For Coding OAuth token, retrying transient upstream failures. */
const refreshToken = Effect.fn("kimi.refreshToken")(function* (
  refresh: string,
  deviceId: string | undefined,
) {
  if (!isKimiCodingDeviceId(deviceId)) {
    return yield* new SubscriptionAuthInputError({
      message: "Kimi For Coding credentials have no valid device id. Reconnect the account.",
    });
  }
  const label = "Kimi For Coding token refresh failed";
  const attempt = postToken(label, deviceId, {
    grant_type: "refresh_token",
    refresh_token: refresh,
  }).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? responseJson(response)
        : Effect.flatMap(responseJson(response), (body) => {
            const error = isTokenErrorBody(body) ? body.error : undefined;
            return Effect.fail(
              new SubscriptionAuthRequestError({
                message: `${label}: ${response.status}${typeof error === "string" ? ` ${error}` : ""}`,
                status: response.status,
              }),
            );
          }),
    ),
    withOAuthTimeout("Kimi For Coding token refresh", REQUEST_TIMEOUT),
  );
  const body = yield* Effect.retry(attempt, refreshRetrySchedule);
  return yield* credentialsFromTokenResponse(body, "refresh", deviceId);
});

/** Effect API for the Kimi For Coding flow; requires an `HttpClient`. */
export const KimiOAuth = {
  startDeviceLogin,
  pollDeviceLogin,
  pollTokenOnce,
  refreshToken,
} as const;

export function startKimiDeviceLogin(options?: {
  signal?: AbortSignal;
}): Promise<KimiDeviceLoginPending> {
  return runOAuthPromise(startDeviceLogin(), options?.signal);
}

export function pollKimiDeviceLogin(
  pending: KimiDeviceLoginPending,
  options?: { signal?: AbortSignal },
): Promise<KimiDevicePollResult> {
  return runOAuthPromise(pollDeviceLogin(pending), options?.signal);
}

export function refreshKimiToken(
  refresh: string,
  signal?: AbortSignal,
  deviceId?: string,
): Promise<OAuthCredentials> {
  return runOAuthPromise(refreshToken(refresh, deviceId), signal);
}
