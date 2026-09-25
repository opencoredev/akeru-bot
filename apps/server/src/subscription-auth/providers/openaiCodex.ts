/**
 * OpenAI Codex OAuth (ChatGPT Plus/Pro subscriptions).
 *
 * Ported from Mastra Code (mastra-ai/mastra,
 * `mastracode/sdk/src/auth/providers/openai-codex.ts`), Apache-2.0.
 *
 * Only the device-code flow is ported. The upstream browser flow waits for a
 * callback on the server's localhost, which cannot work when the client is a
 * phone or a remote browser — every Akeru flow must survive that split, so the
 * headless flow is the only flow.
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  decodeOAuthBody,
  ensureOk,
  responseJson,
  runOAuthPromise,
  sendOAuthRequest,
  SubscriptionAuthResponseError,
  type SubscriptionAuthRequestError,
  withOAuthTimeout,
} from "../oauthHttp.ts";
import type { OAuthCredentials } from "../types.ts";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const DEVICE_USER_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_AUTHORIZE_URL = `${ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const DEFAULT_TOKEN_EXPIRES_IN_SECONDS = 3600;
const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT = "30 seconds";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const USER_AGENT = "akeru";

const AccountIdClaim = Schema.Struct({ chatgpt_account_id: Schema.NonEmptyString });

const JwtClaims = Schema.fromJsonString(
  Schema.Struct({
    chatgpt_account_id: Schema.optional(Schema.Unknown),
    [JWT_CLAIM_PATH]: Schema.optional(Schema.Unknown),
  }),
);
const decodeJwtClaims = Schema.decodeUnknownOption(JwtClaims);
const isAccountId = Schema.is(Schema.NonEmptyString);
const isAccountIdClaim = Schema.is(AccountIdClaim);

function accountIdFromJwt(token: string | undefined): string | undefined {
  const payload = token?.split(".");
  if (payload?.length !== 3) return undefined;
  return decodeJwtClaims(Buffer.from(payload[1] ?? "", "base64url").toString("utf8")).pipe(
    Option.flatMap((claims) =>
      Option.firstSomeOf([
        isAccountId(claims.chatgpt_account_id)
          ? Option.some(claims.chatgpt_account_id)
          : Option.none(),
        isAccountIdClaim(claims[JWT_CLAIM_PATH])
          ? Option.some(claims[JWT_CLAIM_PATH].chatgpt_account_id)
          : Option.none(),
      ]),
    ),
    Option.getOrUndefined,
  );
}

const TokenResponse = Schema.Struct({
  id_token: Schema.optional(Schema.String),
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.optional(Schema.Finite),
});

const DeviceUserCodeResponse = Schema.Struct({
  device_auth_id: Schema.NonEmptyString,
  user_code: Schema.optional(Schema.String),
  usercode: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Union([Schema.Finite, Schema.String])),
});

const DeviceTokenResponse = Schema.Struct({
  authorization_code: Schema.NonEmptyString,
  code_verifier: Schema.NonEmptyString,
});

/** Decode a token response into credentials, resolving the ChatGPT account id. */
const credentialsFromTokenResponse = Effect.fn("codex.credentialsFromTokenResponse")(function* (
  body: unknown,
  missingFieldsMessage: string,
  previousAccountId?: string,
) {
  const tokens = yield* decodeOAuthBody(TokenResponse, missingFieldsMessage)(body);
  const accountId =
    accountIdFromJwt(tokens.id_token) ?? accountIdFromJwt(tokens.access_token) ?? previousAccountId;
  if (accountId === undefined) {
    return yield* new SubscriptionAuthResponseError({
      message: "Failed to extract ChatGPT account id from OpenAI Codex token",
    });
  }
  const now = yield* Clock.currentTimeMillis;
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now + (tokens.expires_in ?? DEFAULT_TOKEN_EXPIRES_IN_SECONDS) * 1000,
    accountId,
  } satisfies OAuthCredentials;
});

const postJson = (label: string, url: string, body: Record<string, string>) =>
  sendOAuthRequest(
    label,
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({ "User-Agent": USER_AGENT }),
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  );

// Callers own the field order so the body bytes match the pre-migration requests.
const postTokenForm = (label: string, params: Record<string, string>) =>
  sendOAuthRequest(
    label,
    HttpClientRequest.post(TOKEN_URL).pipe(HttpClientRequest.bodyUrlParams(params)),
  );

/**
 * Serializable pending state for a Codex device-code login. The device token
 * response carries the `code_verifier`, so no PKCE state spans requests.
 */
export interface CodexDeviceLoginPending {
  deviceAuthId: string;
  userCode: string;
  /** Verification URL for the user to open. */
  url: string;
  instructions: string;
  /** Poll interval in ms suggested by the server. */
  intervalMs: number;
  /** ms epoch after which the device authorization expires. */
  deadlineAt: number;
}

export type CodexDevicePollResult =
  | { status: "complete"; credentials: OAuthCredentials }
  | { status: "pending"; nextPollMs: number }
  | { status: "failed"; error: string };

/** Request a user code and return the pending login state. */
const startDeviceLogin = Effect.fn("codex.startDeviceLogin")(function* () {
  const label = "Failed to initiate OpenAI Codex device authorization";
  const data = yield* postJson(label, DEVICE_USER_CODE_URL, {
    client_id: CLIENT_ID,
    originator: USER_AGENT,
  }).pipe(
    Effect.flatMap(ensureOk(label)),
    Effect.flatMap(responseJson),
    Effect.flatMap(
      decodeOAuthBody(
        DeviceUserCodeResponse,
        "OpenAI Codex device authorization response missing required fields",
      ),
    ),
    withOAuthTimeout("OpenAI Codex device authorization", REQUEST_TIMEOUT),
  );
  const userCode = data.user_code || data.usercode;
  if (!userCode) {
    return yield* new SubscriptionAuthResponseError({
      message: "OpenAI Codex device authorization response missing required fields",
    });
  }
  const intervalSeconds =
    typeof data.interval === "number"
      ? data.interval
      : Number.parseInt(data.interval ?? "", 10) || 5;
  return {
    deviceAuthId: data.device_auth_id,
    userCode,
    url: DEVICE_AUTHORIZE_URL,
    instructions: `Enter code: ${userCode}`,
    intervalMs: Math.max(intervalSeconds, 1) * 1000,
    deadlineAt: (yield* Clock.currentTimeMillis) + DEVICE_AUTH_TIMEOUT_MS,
  } satisfies CodexDeviceLoginPending;
});

/**
 * Perform exactly one upstream poll for a pending Codex device login.
 * The Codex device endpoint signals "still pending" via HTTP 403/404 (it is
 * not an RFC 8628 error-JSON endpoint); on success it returns the
 * authorization code plus server-held PKCE verifier, which is exchanged
 * immediately for credentials. Flow-level conditions are `failed` results;
 * only transport failures and timeouts reach the error channel.
 */
const pollDeviceLogin = Effect.fn("codex.pollDeviceLogin")(function* (
  pending: CodexDeviceLoginPending,
): Effect.fn.Return<
  CodexDevicePollResult,
  SubscriptionAuthRequestError | SubscriptionAuthResponseError,
  HttpClient.HttpClient
> {
  if ((yield* Clock.currentTimeMillis) >= pending.deadlineAt) {
    return {
      status: "failed",
      error: "OpenAI Codex device authorization timed out after 15 minutes",
    };
  }

  const label = "OpenAI Codex device authorization failed";
  const response = yield* postJson(label, DEVICE_TOKEN_URL, {
    device_auth_id: pending.deviceAuthId,
    user_code: pending.userCode,
  });
  if (response.status === 403 || response.status === 404) {
    return { status: "pending", nextPollMs: pending.intervalMs };
  }
  const device = yield* ensureOk(label)(response).pipe(
    Effect.flatMap(responseJson),
    Effect.flatMap(
      decodeOAuthBody(
        DeviceTokenResponse,
        "OpenAI Codex device token response missing required fields",
      ),
    ),
  );

  const tokenResponse = yield* postTokenForm("Token exchange failed", {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: device.authorization_code,
    code_verifier: device.code_verifier,
    redirect_uri: DEVICE_REDIRECT_URI,
  });
  if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
    return { status: "failed", error: "Token exchange failed" };
  }
  const credentials = yield* responseJson(tokenResponse).pipe(
    Effect.flatMap((body) => credentialsFromTokenResponse(body, "Token exchange failed")),
  );
  return { status: "complete", credentials };
}, (effect) =>
  effect.pipe(
    Effect.catchTag("SubscriptionAuthResponseError", (error) =>
      Effect.succeed<CodexDevicePollResult>({ status: "failed", error: error.message }),
    ),
    Effect.catchIf(
      (error) => error.status !== undefined,
      (error) => Effect.succeed<CodexDevicePollResult>({ status: "failed", error: error.message }),
    ),
    withOAuthTimeout("OpenAI Codex device authorization poll", REQUEST_TIMEOUT),
  ),
);

/** Refresh an OpenAI Codex OAuth token, preserving the ChatGPT account id. */
const refreshToken = Effect.fn("codex.refreshToken")(function* (credentials: OAuthCredentials) {
  const label = "OpenAI Codex token refresh failed";
  const body = yield* postTokenForm(label, {
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
    client_id: CLIENT_ID,
  }).pipe(Effect.flatMap(ensureOk(label)), Effect.flatMap(responseJson));
  return yield* credentialsFromTokenResponse(
    body,
    "OpenAI Codex token refresh response missing fields",
    typeof credentials.accountId === "string" ? credentials.accountId : undefined,
  );
}, withOAuthTimeout("OpenAI Codex token refresh", REQUEST_TIMEOUT));

/** Effect API for the OpenAI Codex flow; requires an `HttpClient`. */
export const CodexOAuth = { startDeviceLogin, pollDeviceLogin, refreshToken } as const;

/** Start a Codex device-code login: request a user code and return pending state. */
export function startCodexDeviceLogin(options?: {
  signal?: AbortSignal;
}): Promise<CodexDeviceLoginPending> {
  return runOAuthPromise(startDeviceLogin(), options?.signal);
}

export function pollCodexDeviceLogin(
  pending: CodexDeviceLoginPending,
  options?: { signal?: AbortSignal },
): Promise<CodexDevicePollResult> {
  return runOAuthPromise(pollDeviceLogin(pending), options?.signal);
}

export function refreshCodexToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  return runOAuthPromise(refreshToken(credentials));
}
