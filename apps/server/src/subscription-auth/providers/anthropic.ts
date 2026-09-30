/**
 * Anthropic OAuth flow (Claude Pro/Max).
 *
 * Ported from Mastra Code (mastra-ai/mastra,
 * `mastracode/sdk/src/auth/providers/anthropic.ts`), Apache-2.0; originally
 * inspired by pi-mono's implementation.
 *
 * Paste-code PKCE flow: the redirect lands on Anthropic's hosted callback page
 * which displays `code#state` for the user to paste back. No inbound
 * connection to this server is needed, so the flow works locally, remotely,
 * and from a phone. Only the PKCE verifier spans the two steps.
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientRequest } from "effect/unstable/http";

import { parseAuthorizationInput } from "../authorizationInput.ts";
import {
  decodeOAuthBody,
  ensureOk,
  responseJson,
  runOAuthPromise,
  sendOAuthRequest,
  SubscriptionAuthInputError,
  withOAuthTimeout,
} from "../oauthHttp.ts";
import { generatePKCE } from "../pkce.ts";
import type { OAuthCredentials } from "../types.ts";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT = "15 seconds";

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.Finite,
});

export interface AnthropicLoginStart {
  /** Authorization URL for the user to open. */
  url: string;
  /** PKCE code verifier — persist it to complete the login later. */
  verifier: string;
}

/** Start an Anthropic login: generate PKCE state and build the authorization URL. */
export async function startAnthropicLogin(): Promise<AnthropicLoginStart> {
  const { verifier, challenge } = await generatePKCE();

  const authParams = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });

  return { url: `${AUTHORIZE_URL}?${authParams.toString()}`, verifier };
}

const requestTokens = Effect.fn("anthropic.requestTokens")(function* (
  label: string,
  body: Record<string, string>,
) {
  const tokens = yield* sendOAuthRequest(
    label,
    HttpClientRequest.post(TOKEN_URL).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
  ).pipe(
    Effect.flatMap(ensureOk(label)),
    Effect.flatMap(responseJson),
    Effect.flatMap(decodeOAuthBody(TokenResponse, `${label}: response missing fields`)),
  );
  const now = yield* Clock.currentTimeMillis;
  return {
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: now + tokens.expires_in * 1000 - REFRESH_SKEW_MS,
  } satisfies OAuthCredentials;
});

/**
 * Complete an Anthropic login: parse the pasted authorization input
 * (full URL, `code#state`, or query string), validate its state, and exchange
 * it for tokens using the verifier from `startAnthropicLogin()`.
 */
const completeLogin = Effect.fn("anthropic.completeLogin")(function* (
  input: string,
  verifier: string,
) {
  const { code, state } = parseAuthorizationInput(input);
  if (!code) {
    return yield* new SubscriptionAuthInputError({ message: "Missing authorization code" });
  }
  if (!state || state !== verifier) {
    return yield* new SubscriptionAuthInputError({ message: "Invalid authorization state" });
  }
  return yield* requestTokens("Token exchange failed", {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    state,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  }).pipe(withOAuthTimeout("Anthropic token exchange", REQUEST_TIMEOUT));
});

/** Refresh an Anthropic OAuth token. */
const refreshToken = Effect.fn("anthropic.refreshToken")(function* (refresh: string) {
  return yield* requestTokens("Anthropic token refresh failed", {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refresh,
  }).pipe(withOAuthTimeout("Anthropic token refresh", REQUEST_TIMEOUT));
});

/** Effect API for the Anthropic flow; requires an `HttpClient`. */
export const AnthropicOAuth = { completeLogin, refreshToken } as const;

export function completeAnthropicLogin(input: string, verifier: string): Promise<OAuthCredentials> {
  return runOAuthPromise(completeLogin(input, verifier));
}

export function refreshAnthropicToken(refresh: string): Promise<OAuthCredentials> {
  return runOAuthPromise(refreshToken(refresh));
}
