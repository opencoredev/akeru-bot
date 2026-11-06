# Subscription authentication

Akeru lets a user connect an existing AI subscription or supply an API key. The environment server owns both authentication methods. A custom base URL selects an API-compatible endpoint for API-key connections; it does not change subscription OAuth endpoints.

Supported account flows:

- ChatGPT subscription through OpenAI Codex device authorization
- Grok subscription through xAI device authorization
- Kimi For Coding through Moonshot device authorization

Claude and OpenCode Go take an API key only (`providerRequiresApiKey` in `serviceTypes.ts` and `@akeru/client-runtime/provider-auth`). Akeru no longer offers Claude Pro or Max sign-in. Anthropic's [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead." No request from Akeru claims to be a vendor CLI: there is no Claude Code user agent, no `claude-code` beta, and no Claude Code system prompt. See [the sign-in route table](./providers.md#subscription-sign-in-routes) for each remaining route and its evidence.

The flow implementations are ported from Mastra Code under Apache-2.0. The Kimi flow follows `mastra-ai/mastra` pull request 22428.

## Retired Claude logins

Older versions stored Claude Pro or Max OAuth credentials under `anthropic`, `instance:anthropic:<id>`, and `account:anthropic:<id>`. `SubscriptionAuthService.make` deletes all of them when it loads the file, so no Claude subscription token stays on disk:

- Before it deletes them, the service writes `retiredLoginRemovedAt` into the health record for each removed scope in `subscription-auth.json.health`. A backup account's marker goes on the default `anthropic` record, because a removed backup has no row of its own. Writing the marker first means a failed credential write cannot lose the guidance. Saving an API key for a scope deletes that scope's health record, which clears the marker.
- `credentialAt` still skips an `anthropic` OAuth credential (`isRetiredCredential`), so a login that another writer saves after startup, such as an older Akeru version running against the same file, is never used. The next startup deletes it. Token redaction still covers stored secrets.
- While a scope has a marker or an ignored login and no API key, status reports `connected: false`, health `missing`, `reconnectAction: "Connect API key"`, and a `credentialWarning` with `CLAUDE_SUBSCRIPTION_RETIRED_MESSAGE`. The access guide shows that warning on web and mobile.
- `HarnessProviderStatus` uses the same message as the Claude instance's readiness message. Send preflight returns that `credentialWarning` for a `missing`, unauthenticated instance before it reads request health, so request health recorded before the upgrade cannot replace the message with a generic sign-in step.
- Deletion is one-way. After a rollback to a version that still offers Claude Pro or Max sign-in, the user has to sign in again.
- A pending Claude paste-code login in `subscription-auth.json.pending` is dropped on load, like retired Cursor logins. `subscriptionAuth.start` with `authMode: "oauth"` for Claude fails with the same message; without `authMode` it starts an API-key login.
- `CLAUDE_CODE_OAUTH_TOKEN` is no longer a Claude transport or a connection variable. The Mastra transport accepts `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` (an API gateway bearer), or the saved Anthropic API key.

## Storage boundary

The environment server owns credentials. It writes them to:

```text
<stateDir>/secrets/subscription-auth.json
```

The directory uses mode `0700`. The file uses mode `0600`. Clients submit API keys through `subscriptionAuth.complete`; the server never returns saved keys. OAuth access tokens and refresh tokens never cross the WebSocket contract. Status includes the authentication method and custom base URL, but no credentials.

`apps/server/src/subscription-auth/credentialStore.ts` owns the file. It reads and writes through the Effect `FileSystem` and `Path` services and decodes with Schema. Known provider entries must match the OAuth or API key shape. Other keys, such as the `apikey:<provider>` records Mastra's `AuthStorage` writes to the same file, pass through and survive rewrites.

Every `SubscriptionAuthService` in the process shares one store per resolved path, so a login through one service is visible to every other service in the process at once. An update rereads the file, applies the change, writes a temporary file with mode `0600` in the same directory, and renames it over the original. Updates and reloads hold one semaphore, so concurrent updates run one at a time and none is lost.

Other writers change the file too: Mastra's `AuthStorage` rewrites it in place, and another server process has its own store. The synchronous readers (`isConnected`, `getApiKeyCredential`, `getAccessToken`, `statuses`) stay fresh through a stat check in `current()`. The store remembers the device, inode, size, and nanosecond mtime of the version it last read or wrote. When a `statSync` shows a different fingerprint, `current()` rereads and decodes the file before answering. An unchanged file costs one `stat`. While an update or reload owns the file, `current()` answers from memory instead of reading a half-finished replacement. A same-size in-place rewrite inside one filesystem timestamp tick can go unseen until the next change or explicit reload. `sessionReset` compares `getApiKeyCredential` before and after an RPC operation, so it also sees a key another writer saved during that operation.

A file that cannot be decoded does not look like a logout, and the UI and runtime always agree on what it means:

- **Damaged after a good read.** If this process already read or wrote a good version, the store keeps serving that last good state everywhere. The state carries a typed `SubscriptionCredentialStoreError` and `servingLastGood: true`, and the store logs a warning once when the damage first appears. Provider statuses keep their real `connected`, health, and test fields and add a `credentialWarning` with the time the damage was first seen. Settings on web and mobile show the warning under each provider row. Runtime getters keep returning the last good credentials.
- **Damaged with no good read.** If the file was already damaged when the store first loaded it, there is nothing to fall back on. The store state is empty, every provider status reports `connected: false` and `failed-first-request` with a reconnect message, and `getAccessToken`, `getApiKeyCredential`, and `isConnected` report no credential.

Either way the damaged file stays on disk until the next successful write. That write builds on the served state (the last good credentials, or nothing), moves the damaged file to `subscription-auth.json.corrupt`, and writes the new file. A repaired file clears the error on the next read. A file the server cannot read at all reports reason `unreadable`, and updates refuse to overwrite it.

The default instance for each provider keeps its historical provider key in this file. Added
instances use `instance:<provider>:<instanceId>` keys. A pending login carries the instance ID
through polling or code completion, and refresh uses the same key. This preserves existing
single-account credentials without rewriting the file. `subscriptionAuth.logout` deletes only the
selected instance's credential and health record.
Removing a custom instance through the settings RPC also deletes its credential after the settings
update succeeds. Removing a default instance override keeps the default account connected.

Local desktop, a remote server, and a future hosted control plane use the same boundary. The storage adapter can move from the local file to an encrypted tenant secret store without changing the client contract.

## Access copy in Settings

`providerAccessGuide` in `packages/client-runtime/src/providerAccessGuide.ts` turns a `SubscriptionProviderStatus` into the access lines that web and mobile Settings show: what unlocks the provider, the other credential, whether the subscription includes API access, published limits, what the environment has saved, and one next step. Web renders it in `ProviderAccessDetails` and mobile in `ProviderAccessSummary`. Both pass their locale's translator, so the copy lives once in the shared catalogs.

The guide calls access ready only when `health` is `healthy` or `recovered`, meaning the server recorded a successful provider request. `detected` stays "Not verified yet", and the optional `healthChecking` flag shows "Checking access" while the post-login check runs. Subscription statuses never report `unsupported` or `disabled`, so the guide has no state for them. The guide does not run checks; the server's health test owns that. Model names come from the default instance's `ServerProvider.models` in the environment config, so the list matches the environment the user is looking at. Custom instances keep their own credentials and are not listed.

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

- `subscriptionAuth.start` creates a pending login. An optional `instanceId` binds it to a configured instance of that provider. An `authMode` of `api-key` selects key entry and accepts an optional `baseUrl`. OAuth remains the default for subscription providers.
- `subscriptionAuth.poll` performs one upstream poll for a device or browser-poll flow.
- `subscriptionAuth.complete` stores the pasted key for an API-key login. No OAuth flow completes with a pasted code.
- `subscriptionAuth.cancel` removes abandoned pending state.
- `subscriptionAuth.logout` removes the selected instance's stored credential. Without `instanceId`, it removes the historical default account.

OpenAI's localhost callback flow is intentionally not used. A callback on the server machine cannot complete from a phone or remote browser. The Codex device flow works across every Akeru surface.

Pending login state stays on the environment server. It is bounded and contains no completed access or refresh token. Device-code state is JSON-serializable so a later hosted implementation can persist it in the tenant database and let any replica continue polling.

## Upstream requests

Each module in `apps/server/src/subscription-auth/providers/` exports an Effect API (`CodexOAuth`, `KimiOAuth`, `XAIOAuth`) that requires an `HttpClient`, plus Promise wrappers that `SubscriptionAuthService` calls. The wrappers run the Effect API with the fetch-backed client from `oauthHttp.ts`.

Response bodies are decoded with Schema. Failures use three tagged errors: `SubscriptionAuthRequestError` for transport failures, timeouts, and non-2xx responses; `SubscriptionAuthResponseError` for bodies with the wrong shape; and `SubscriptionAuthInputError` for unusable device ids. A request error message includes the HTTP status, because the service classifies revoked grants by matching `401`, `403`, `invalid_grant`, or `revoked` in the message. Every upstream operation has an `Effect.timeout` bound of 30 seconds. Kimi For Coding refresh retries transport failures, timeouts, 429, and 5xx responses after 1, 2, and 4 seconds.

`deviceCode.ts` folds one RFC 8628 poll into the serializable state and reads time from the Effect `Clock`. `subscriptionAuth.poll` runs one step per request. `pollDeviceCodeUntilSettled` runs the same steps on a `Schedule` that waits the server interval and grows it after `slow_down`. The Codex device endpoint is not RFC 8628: it reports a pending login as 403 or 404 and uses a fixed 15-minute deadline.

Tests replace the client with `testUtils/scriptedHttpClient.ts` and drive timeouts, retries, and poll intervals with `TestClock`.

## Runtime integration

`SubscriptionAuthService.getAccessToken(provider, instanceId)` returns a valid OAuth access token or the saved API key. It serializes concurrent OAuth refresh requests per account. `getApiKeyCredential(provider, instanceId)` returns the current server-owned API key and its optional base URL for runtime use only. Omitting `instanceId` selects the historical default account; other provider instances keep their own account under an `instance:<provider>:<instanceId>` key. Both read through the store's stat check, so they see changes other writers made.

Codex uses the OpenAI Responses API when an API key is saved and keeps the Codex subscription transport for OAuth. Claude has no subscription transport. Claude, Grok, Kimi, and OpenCode Go resolve saved keys and custom endpoints through their Mastra model transports. Standard OpenCode receives saved API credentials when its adapter starts a provider process. The login, completion, and logout RPC paths stop affected sessions when the API key or endpoint changes. The next turn starts a new session with the current connection. Grok supports API keys at its default endpoint; its current transport rejects custom base URLs.

The standard OpenCode CLI driver is no longer synthesized as a default instance. Explicit old
OpenCode instances remain routable for existing settings and chats. OpenCode Go is the supported
provider option in Settings.

## Post-login health check

The service checks health itself right after it stores a credential, so the result does not depend on the client that finished login staying connected. `ws.ts` enables this with `forSecretsDir(dir, { checkHealthOnConnect: true })`. Other callers and tests leave it off, which keeps them off the network.

While a check runs, the health file holds a `healthCheckStartedAt` marker. `statuses()` reports it as the optional `healthChecking` flag, and ignores markers older than 60 seconds so a crashed server cannot leave a provider stuck in checking. A connected login progress result carries `health: "checking"` when a check started. The flag is optional rather than a new health literal so older clients still decode the status. Tests wait on `awaitHealthCheck(provider)`.

Each provider's request:

- Codex OAuth: `GET https://chatgpt.com/backend-api/wham/usage` with the bearer token.
- Grok OAuth: `GET https://api.x.ai/v1/models` with the bearer token.
- Kimi OAuth: `GET https://api.kimi.com/coding/v1/models` with the bearer token and the `X-Msh-*` device headers from `getKimiCodingDeviceHeaders(credential.deviceId)`.
- API keys, including Claude and OpenCode Go: the provider's usage or models endpoint at the saved base URL. Claude sends `x-api-key` and `anthropic-version` to `/v1/models`.

Every request times out after 30 seconds.

Custom endpoints must use the selected provider's protocol. They do not make every model compatible with every driver. Health checks use the selected endpoint and disable HTTP redirects so a redirect cannot forward a key to another host.
