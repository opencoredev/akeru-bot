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

## Runtime integration

`SubscriptionAuthService.getAccessToken(provider)` returns a valid OAuth access token or the saved API key. It serializes concurrent OAuth refresh requests. `getApiKeyCredential(provider)` reloads the server-owned credential and returns its optional base URL for runtime use only.

Codex uses the OpenAI Responses API when an API key is saved and keeps the Codex subscription transport for OAuth. Kimi and OpenCode Go resolve keys and custom endpoints for model requests. Claude, Grok, and OpenCode receive saved API credentials when their adapter starts a provider process. The login, completion, and logout RPC paths stop affected bridge sessions when the API key or endpoint changes. The next turn starts a new process with the current connection. Grok supports API keys at its default endpoint; its current bridge rejects custom base URLs.

Custom endpoints must use the selected provider's protocol. They do not make every model compatible with every driver. Health checks use the selected endpoint and disable HTTP redirects so a redirect cannot forward a key to another host.
