# Subscription authentication

Akeru lets a user connect an existing AI subscription or supply an API key. The environment server owns both authentication methods. A custom base URL selects an API-compatible endpoint for API-key connections; it does not change subscription OAuth endpoints.

Supported account flows:

- ChatGPT subscription through OpenAI Codex device authorization
- Claude Pro or Max through Anthropic paste-code PKCE
- Grok subscription through xAI device authorization
- Kimi For Coding through Moonshot device authorization

The flow implementations are ported from Mastra Code under Apache-2.0. The Kimi flow follows `mastra-ai/mastra` pull request 22428.

## Storage boundary

The environment server owns credentials. It writes them to:

```text
<stateDir>/secrets/subscription-auth.json
```

The directory uses mode `0700`. The file uses mode `0600`. Writes use a temporary file and atomic rename. Clients submit API keys through `subscriptionAuth.complete`; the server never returns saved keys. OAuth access tokens and refresh tokens never cross the WebSocket contract. Status includes the authentication method and custom base URL, but no credentials.

Local desktop, a remote server, and a future hosted control plane use the same boundary. The storage adapter can move from the local file to an encrypted tenant secret store without changing the client contract.

## Sandbox boundary

Do not store OAuth refresh tokens in an E2B sandbox, project workspace, checkpoint, event, database projection, log, or client persistence.

When a run starts:

1. The environment server refreshes the provider credential if required.
2. It resolves a short-lived access token.
3. It passes only that access token to the agent runtime or sandbox for that run.
4. The sandbox loses the token when the run or sandbox ends.

This limits the lifetime of OAuth access in a sandbox. API keys do not have the same short-lived guarantee. Keep keys in the environment secret store and pass them only to the provider runtime that needs them.

## Remote-ready login

The client drives every login over RPC:

- `subscriptionAuth.start` creates a pending login. An `authMode` of `api-key` selects key entry and accepts an optional `baseUrl`. OAuth remains the default for subscription providers.
- `subscriptionAuth.poll` performs one upstream poll for a device or browser-poll flow.
- `subscriptionAuth.complete` exchanges a pasted code for Anthropic OAuth or stores a key for an API-key login.
- `subscriptionAuth.cancel` removes abandoned pending state.
- `subscriptionAuth.logout` removes the stored credential.

OpenAI's localhost callback flow is intentionally not used. A callback on the server machine cannot complete from a phone or remote browser. The Codex device flow works across every Akeru surface.

Pending login state stays on the environment server. It is bounded and contains no completed access or refresh token. Device-code state is JSON-serializable so a later hosted implementation can persist it in the tenant database and let any replica continue polling.

## Upstream requests

Each module in `apps/server/src/subscription-auth/providers/` exports an Effect API (`AnthropicOAuth`, `CodexOAuth`, `KimiOAuth`, `XAIOAuth`) that requires an `HttpClient`, plus Promise wrappers that `SubscriptionAuthService` calls. The wrappers run the Effect API with the fetch-backed client from `oauthHttp.ts`.

Response bodies are decoded with Schema. Failures use three tagged errors: `SubscriptionAuthRequestError` for transport failures, timeouts, and non-2xx responses; `SubscriptionAuthResponseError` for bodies with the wrong shape; and `SubscriptionAuthInputError` for unusable pasted codes or device ids. A request error message includes the HTTP status, because the service classifies revoked grants by matching `401`, `403`, `invalid_grant`, or `revoked` in the message. Every upstream operation has an `Effect.timeout` bound: 15 seconds for Anthropic and 30 seconds for the others. Kimi For Coding refresh retries transport failures, timeouts, 429, and 5xx responses after 1, 2, and 4 seconds.

`deviceCode.ts` folds one RFC 8628 poll into the serializable state and reads time from the Effect `Clock`. `subscriptionAuth.poll` runs one step per request. `pollDeviceCodeUntilSettled` runs the same steps on a `Schedule` that waits the server interval and grows it after `slow_down`. The Codex device endpoint is not RFC 8628: it reports a pending login as 403 or 404 and uses a fixed 15-minute deadline.

Tests replace the client with `testUtils/scriptedHttpClient.ts` and drive timeouts, retries, and poll intervals with `TestClock`.

## Runtime integration

`SubscriptionAuthService.getAccessToken(provider)` returns a valid OAuth access token or the saved API key. It serializes concurrent OAuth refresh requests. `getApiKeyCredential(provider)` reloads the server-owned credential and returns its optional base URL for runtime use only.

Codex uses the OpenAI Responses API when an API key is saved and keeps the Codex subscription transport for OAuth. Kimi and OpenCode Go resolve keys and custom endpoints for model requests. Claude, Grok, and OpenCode receive saved API credentials when their adapter starts a provider process. The login, completion, and logout RPC paths stop affected bridge sessions when the API key or endpoint changes. The next turn starts a new process with the current connection. Grok supports API keys at its default endpoint; its current bridge rejects custom base URLs.

## Post-login health check

The service checks health itself right after it stores a credential, so the result does not depend on the client that finished login staying connected. `ws.ts` enables this with `forSecretsDir(dir, { checkHealthOnConnect: true })`. Other callers and tests leave it off, which keeps them off the network.

While a check runs, the health file holds a `healthCheckStartedAt` marker. `statuses()` reports it as the optional `healthChecking` flag, and ignores markers older than 60 seconds so a crashed server cannot leave a provider stuck in checking. A connected login progress result carries `health: "checking"` when a check started. The flag is optional rather than a new health literal so older clients still decode the status. Tests wait on `awaitHealthCheck(provider)`.

Each provider's request:

- Claude OAuth: `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20`, and the Claude Code user agent, matching the plan-limit reader.
- Codex OAuth: `GET https://chatgpt.com/backend-api/wham/usage` with the bearer token.
- Grok OAuth: `GET https://api.x.ai/v1/models` with the bearer token.
- Kimi OAuth: `GET https://api.kimi.com/coding/v1/models` with the bearer token and the `X-Msh-*` device headers from `getKimiCodingDeviceHeaders(credential.deviceId)`.
- API keys, including OpenCode Go: the provider's usage or models endpoint at the saved base URL.

Every request times out after 30 seconds.

Custom endpoints must use the selected provider's protocol. They do not make every model compatible with every driver. Health checks use the selected endpoint and disable HTTP redirects so a redirect cannot forward a key to another host.
