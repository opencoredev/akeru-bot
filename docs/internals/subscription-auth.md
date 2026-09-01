# Subscription authentication

Akeru lets a user connect an existing AI subscription. It does not ask for an API key and it does not run a provider CLI to authenticate.

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

The directory uses mode `0700`. The file uses mode `0600`. Writes use a temporary file and atomic rename. OAuth access tokens and refresh tokens never cross the WebSocket contract. Clients only receive provider status, an authorization URL, a user code when required, and login progress.

Local desktop, a remote server, and a future hosted control plane use the same boundary. The storage adapter can move from the local file to an encrypted tenant secret store without changing the client contract.

## Sandbox boundary

Do not store OAuth refresh tokens in an E2B sandbox, project workspace, checkpoint, event, database projection, log, or client persistence.

When a run starts:

1. The environment server refreshes the provider credential if required.
2. It resolves a short-lived access token.
3. It passes only that access token to the agent runtime or sandbox for that run.
4. The sandbox loses the token when the run or sandbox ends.

This keeps a disposable sandbox disposable. A stolen sandbox cannot renew access after its short-lived token expires.

## Remote-ready login

The client drives every login over RPC:

- `subscriptionAuth.start` creates a pending login and returns the provider URL.
- `subscriptionAuth.poll` performs one upstream poll for a device or browser-poll flow.
- `subscriptionAuth.complete` exchanges a pasted code for Anthropic.
- `subscriptionAuth.cancel` removes abandoned pending state.
- `subscriptionAuth.logout` removes the stored credential.

OpenAI's localhost callback flow is intentionally not used. A callback on the server machine cannot complete from a phone or remote browser. The Codex device flow works across every Akeru surface.

Pending login state stays on the environment server. It is bounded and contains no completed access or refresh token. Device-code state is JSON-serializable so a later hosted implementation can persist it in the tenant database and let any replica continue polling.

## Runtime integration

`SubscriptionAuthService.getAccessToken(provider)` is the runtime seam. It returns a valid short-lived access token and serializes concurrent refresh requests. The current provider CLI adapters do not consume this seam yet. The Mastra runtime must call it when subscription-backed model execution replaces the legacy CLI harness.
