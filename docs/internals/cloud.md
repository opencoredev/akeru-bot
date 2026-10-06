# Akeru Cloud

> For maintainers.

Akeru Cloud is an optional hosted service in `apps/cloud`. Akeru Bot works without it. A user who wants hosted features links an environment to a cloud account once; the environment then keeps one outbound WebSocket to the cloud, and every hosted feature runs over that socket. This release ships account linking and the relay foundation, with no hosted bots yet. The Worker has Slack relay routes, but no production environment consumer attaches to them.

The wire contract lives in `packages/contracts/src/cloud.ts`. The environment side and the cloud both build against it.

## Architecture

The cloud is one Cloudflare Worker named `akeru-cloud`, managed with Alchemy in `apps/cloud/infra/alchemy.run.ts`. It owns:

- **A D1 database** for accounts, linked environments, link codes, channel routes, pending OAuth flows, and daily event counts. Schema: `apps/cloud/migrations`.
- **The `EnvironmentHub` Durable Object**, one instance per environment id (`idFromName`). It holds that environment's socket through the WebSocket Hibernation API, relays events to it, and answers its requests.
- **A React SPA** in `apps/cloud/web`, served as static assets. `/v1/*` and `/api/*` always reach the Worker first; every other path falls back to the SPA.
- **A daily cron** at 04:00 UTC that deletes expired link codes and OAuth flows and usage counters older than 90 days.

Browser sign-in uses Clerk. The SPA sends the Clerk session token as a bearer token to `/api/*`, and the Worker checks it with `@clerk/backend`. The Worker ignores Clerk's session cookie, and `requireUser` rejects any `POST` without `Authorization: Bearer`. JSON bodies must be sent as `content-type: application/json`. A cross-site page cannot set either header without a CORS preflight, which the Worker never approves, so these rules block CSRF. Sign-in methods (Google and email) are configured in the Clerk dashboard. A user is an admin when their Clerk `publicMetadata.role` is `"admin"`.

## Routes

| Path                                       | Caller           | Purpose                                                                         |
| ------------------------------------------ | ---------------- | ------------------------------------------------------------------------------- |
| `GET /v1/health`                           | anyone           | Liveness and protocol version.                                                  |
| `POST /v1/link/start`                      | environment      | Starts a device link.                                                           |
| `POST /v1/link/poll`                       | environment      | Polls a device link.                                                            |
| `GET /v1/environments/connect`             | environment      | Upgrades to the environment socket. `Authorization: Bearer <environmentToken>`. |
| `ALL /v1/channels/:provider/:routeId[/*]`  | channel provider | Hosted channel inbound URL.                                                     |
| `GET /v1/oauth/callback`                   | browser redirect | OAuth redirect for every hosted OAuth flow.                                     |
| `GET /api/config`                          | SPA              | Clerk publishable key, so one build serves every stage.                         |
| `GET /api/me`                              | signed-in user   | Account, environments with live status, hosted bots.                            |
| `GET /api/link?code=`                      | signed-in user   | What an unused user code would link.                                            |
| `POST /api/link/approve`, `/api/link/deny` | signed-in user   | Decides a link code. Body `{ "userCode": "ABCD-EFGH" }`.                        |
| `POST /api/environments/:id/revoke`        | owner            | Unlinks an environment.                                                         |
| `GET /api/admin/overview`                  | admin            | Users, environments, routes, and seven days of event counts.                    |

## Environment link

1. The environment calls `/v1/link/start` with its name and version. The cloud returns a device code (32 random bytes), a user code such as `KQ7M-3XHD`, a verification URL `<cloud>/link?code=KQ7M-3XHD`, a ten-minute expiry, and a three-second poll interval.
2. The user opens the URL, signs in, and approves or denies.
3. Approval generates an independent random environment id and token. D1 stores the token hash for authentication and an AES-GCM encrypted handoff using a domain-separated key derived from the Worker's Clerk secret. The environment polls to create the environment row and receive its credential. Lost responses can be retried for 30 seconds after the first successful poll, bounded by the code's ten-minute expiry. An authenticated socket hello confirms receipt and clears the ciphertext immediately. Later polls clear the ciphertext and return `expired`; starts and maintenance also clear expired handoffs. Revoked links return `denied`. Starts allow five outstanding codes and ten attempts per minute per `CF-Connecting-IP`, stored as a hash, with a 10,000-code global safety ceiling.
4. The environment stores the token in its secret store and connects to `/v1/environments/connect`. The Worker hashes the token, checks it in D1, and hands the upgrade to that environment's hub. Unknown tokens get `401`. A revoked environment or disabled account gets `410`. The environment forgets its token on either.

The Node socket transport reads the refused upgrade response directly through `unexpected-response`. It reports `401` or `410` to the connection service without sending a second request. Plain authenticated `GET` requests remain available for diagnostics and return `426` for a valid token.

Revoking from the SPA marks the environment revoked, disables its routes, deletes its pending OAuth flows, and calls the hub's `revoke()`, which sends `revoked` and closes the socket. The environment can unlink itself over the socket with `environment.unlink`, which does the same revoke.

An approved code can only create an environment before it expires. The expiry and account checks are part of the conditional insert. Repeated polls never create a second environment.

## Socket protocol

The environment sends `CloudEnvironmentMessage` and receives `CloudServerMessage`, both JSON text frames.

- `hello` gets `welcome` with the account email and the cloud's capabilities (`["hosted-channels"]`). The hub also records the environment's name and version, then sends one `channel.missed` per route that received events while the environment was offline. If the account row is gone, the hub sends `revoked` instead and closes with 4001.
- `ping` gets `pong`. `last_seen_at` is written at most once a minute.
- `channel.route.create`, `channel.route.update`, `channel.route.delete`, and `oauth.begin` each get a `result` with the same `requestId`. Invalid messages that carry a `requestId` get an `invalid-request` result.
- `environment.unlink` revokes the environment exactly as the account page does, answers `result` with `{ "type": "empty" }`, and closes the socket with code 4001. Already-revoked account-page requests can be retried safely; socket requests on a revoked link are refused.
- A newer connection for the same environment closes the older one with code 4000.

## Hosted channels

This release ships the relay foundation, with no hosted bots yet. `HostedChannelRelay.attach` has no production caller and the environment advertises no hosted-channel capability. A future channel runtime must attach a consumer and handle provider signatures and deduplication before hosted bot setup is available.

A channel route is a public inbound URL owned by one environment: `<cloud>/v1/channels/slack/rt_…`. An account can have up to 25 active routes; disabled routes do not count. Route ids are public and are not secrets; the environment verifies each provider's request signature itself.

When a request arrives at a route URL, the Worker:

1. Answers `503` when `KILL_SWITCH` is set.
2. Rejects methods other than `GET` and `POST`, and bodies over 1 MiB with `413`. The body is read with a running count, so a chunked body without `content-length` is cut off as soon as it passes the limit.
3. Lets the provider module answer preflight requests. Slack's `url_verification` is answered statelessly because Slack checks the URL while `apps.manifest.create` runs, before the route knows its app.
4. Looks up the route. Unknown routes get `404`; disabled routes and routes of revoked environments get `410`.
5. Sends `channel.inbound` to the hub with the method, the path below the route URL, the exact body bytes as `bodyBase64`, and only the headers the provider allows (Slack: `content-type` and `x-slack-*`). Base64 keeps bytes that are not valid UTF-8 intact, so signatures verify over what the provider sent.
6. Returns `200` at once, including when the environment is offline. Offline events are counted in `daily_usage.dropped` and in hub storage, and reported as `channel.missed` on the next `hello`. Each route may burst 30 events and then 30 per second; past that the Worker returns `429`.

Provider retries are relayed like first deliveries. The cloud cannot tell a duplicate from an event the environment never handled. The future environment consumer must deduplicate handled events; no hosted Slack consumer ships in this foundation.

### OAuth

`oauth.begin` stores a flow with a hashed single-use state and a ten-minute expiry. Every flow redirects to `<cloud>/v1/oauth/callback`.

- `slack.manager` is Akeru's own Slack app. The cloud owns its client secret, so it returns an `authorizeUrl` asking for the user scope `app_configurations:write`. On callback the cloud exchanges the code at `oauth.v2.access` and sends the user token to the environment in `oauth.completed`. The environment uses it to create one Slack app per bot through the Manifest API.
- `slack.install` installs one of those per-bot apps. The environment owns that app's client secret, so the cloud returns only the state and redirect URI and, on callback, relays the code in `oauth.completed`.

The callback checks the environment and account in D1, then checks that the hub has a welcomed socket before exchanging anything. Offline callbacks keep their state and can be retried until expiry. A short D1 lease serializes callbacks. Completion results are stored as AES-GCM ciphertext keyed by a domain-separated hash of the secret callback state, which is not stored. A retry after failed delivery decrypts that result instead of exchanging the provider code again. Successful delivery deletes the flow; expiry maintenance removes undelivered results.

## What the cloud stores

Stored: bounded encrypted link-token handoffs, Clerk user id and email, environment names and versions, SHA-256 hashes of environment tokens, device codes, and OAuth state, route metadata (label, provider, Slack app id, workspace id and name), timestamps, and daily delivered and dropped counts per route.

Never stored in plaintext: message content, request bodies, Slack tokens, per-bot client secrets, environment tokens, or raw codes. OAuth completion ciphertext may temporarily hold a manager token or install code until delivery or expiry. Its decryption key is derived from the raw callback state and is never stored. Missed-event records in hub storage hold only a count, provider, and first timestamp.

Server-side PostHog events are keyed by Clerk user id: `signed_up`, `environment_linked`, `environment_revoked`, `hosted_channel_route_created`, and `hosted_channel_route_deleted`. They carry no content, tokens, or the environment's anonymous usage id. Without `POSTHOG_KEY` nothing is sent.

## Extending the cloud

Each feature is a module under `apps/cloud/src/modules/<name>/` with one `register<Name>(app)` function that `src/app.ts` calls. Handlers read their dependencies from `c.env` (`CloudDeps` in `src/deps.ts`), which tests replace with fakes.

- **A new module**: add the folder and register it in `src/app.ts`. Put browser routes under `/api/*` behind `requireUser`, and public protocol routes under `/v1/*`.
- **A new socket capability**: add message kinds to `CloudEnvironmentMessage` and `CloudServerMessage` in the contracts, add a `CloudCapability` literal, handle the kinds in `EnvironmentHub.webSocketMessage`, and add the capability to `CLOUD_CAPABILITIES`. Environments that do not advertise it never send the new kinds.
- **A new channel provider**: add the provider to `CloudHostedChannelProvider`, write a module under `modules/channels/<provider>/` that says which headers to forward and answers any stateless preflight, and register it in `modules/channels/providers.ts`. Add OAuth purposes there too if the provider needs them.

Hosted iMessage is the expected next channel. It would add `"imessage"` to the provider list and an `imessage` module. Unlike Slack, the inbound side would come from a relay the cloud runs rather than from the provider posting to a URL, so its module would deliver `channel.inbound` through the same `EnvironmentHub.relayInbound` path and reuse the route, cap, missed-event, and usage accounting.

## Stages

The stack has three stages. Each is its own Worker, D1 database, and hub namespace.

| Stage        | Resources               | URL                                                 | Deployed by                     | State                       |
| ------------ | ----------------------- | --------------------------------------------------- | ------------------------------- | --------------------------- |
| `production` | `akeru-cloud`           | `https://akeru-cloud.leoisadev.workers.dev`         | CI, on every push to `main`     | Cloudflare state store      |
| `staging`    | `akeru-cloud-staging`   | `https://akeru-cloud-staging.leoisadev.workers.dev` | any checkout on the dev machine | Cloudflare state store      |
| `local`      | workerd on this machine | `http://localhost:1337`                             | `alchemy dev`, nothing deployed | `apps/cloud/infra/.alchemy` |

The production URL is the contracts default, `DEFAULT_AKERU_CLOUD_URL`; staging is `STAGING_AKERU_CLOUD_URL`. Names are pinned, so a checkout without state can take over existing resources with `alchemy deploy --stage <stage> --adopt`. The account's workers.dev subdomain is `leoisadev`; Alchemy looks it up through the API, and `CLOUDFLARE_WORKERS_SUBDOMAIN` skips that lookup.

The hub is a SQLite-backed Durable Object. Alchemy declares every new Durable Object class with `new_sqlite_classes`, so the stack runs on the Workers Free plan.

### Deploy tooling

Alchemy lives in its own private package, `@akeru/cloud-infra` in `apps/cloud/infra`, because it needs a newer Effect than the rest of the repository. Alchemy 2.0.0-beta.79 requires Effect `>=4.0.0-rc.115`, while the catalog pins `4.0.0-beta.103`, and Effect `4.0.0-rc.118` removed the `effect/unstable/*` paths Alchemy imports. The infra package pins `effect` and `@effect/platform-node` to `4.0.0-rc.115`, and scoped `overrides` in `pnpm-workspace.yaml` keep Alchemy's Effect dependencies on that version. Nothing else in the workspace uses it.

The Worker in `apps/cloud/src` never imports Alchemy. It declares its bindings in `src/env.ts`, and `alchemy.run.ts` fails the infra typecheck if the bindings Alchemy infers drift from that type. Alchemy bundles `../src/worker.ts`, which resolves Effect from `apps/cloud`, so the deployed Worker contains only the catalog Effect. The stack reads the SPA from `apps/cloud/dist/web` and migrations from `apps/cloud/migrations`.

Typecheck the stack with `vp run --filter @akeru/cloud-infra typecheck`.

### Production

`.github/workflows/cloud-deploy.yml` runs on every push to `main` that touches `apps/cloud`, `packages/contracts`, or the workflow. It tests the cloud and its contracts, typechecks, builds the SPA, and runs `alchemy deploy --stage production --yes` with `ALCHEMY_STATE=cloudflare`. **Run workflow** can deploy either stage by hand.

### Staging

Staging is the developer's cloud. It is public, so real Slack apps can reach it. Deploy it from the repository root of any checkout on the dev machine, the main checkout or any worktree:

```bash
vp run cloud:deploy:staging
```

That runs `deploy:staging` in `apps/cloud`, which builds the SPA and then runs `deploy:staging` in `apps/cloud/infra`: `alchemy deploy --stage staging` with `ALCHEMY_STATE=cloudflare`. Every checkout and CI share the account's Cloudflare state store, so any of them can deploy without drift. The first deploy from a machine may ask to create or upgrade the state store. Alchemy uses the profile in `~/.alchemy`.

Akeru servers started from source with `vp run dev` use staging by default, so a dev environment links to staging with no configuration. See [environment side](./cloud-environment.md#the-cloud-origin).

### Local

`vp run cloud:dev` from the repository root, or `vp run dev` in `apps/cloud`, builds the SPA and runs `alchemy dev --stage local`. Alchemy runs the Worker in a local workerd with local emulation of D1 (migrations applied through the same pipeline as a deploy), the SQLite-backed Durable Object, static assets with the SPA fallback, and the cron trigger (also callable at `/cdn-cgi/handler/scheduled`). These local providers create nothing in Cloudflare, but Alchemy still reads the account from your profile. Local storage persists under `apps/cloud/infra/.alchemy/local` in that checkout. It reloads when the stack's sources change; rebuild the SPA with `vp run build:web` to see web changes.

The Worker listens on port 1337 and fails to start if that port is taken, because the public URL, link URLs, and Clerk's authorized party all use it. Only one checkout on a machine can run the local cloud at a time. Point a dev server at it with `AKERU_CLOUD_URL=http://localhost:1337 vp run dev`. Slack cannot reach `localhost`, so test hosted Slack on staging.

### Secrets

The package scripts run Alchemy through `apps/cloud/infra/scripts/alchemy.ts`, which loads the stage's configuration before Alchemy starts. Later sources win:

1. The shell environment.
2. `~/.config/akeru-cloud/<stage>.env`, where `<stage>` is `production`, `staging`, or `local`. This file is shared by every checkout on the machine, so a new worktree needs no setup.
3. `apps/cloud/.env` in the checkout, if present. It is gitignored and optional, for one-off overrides.

The wrapper prints which files it read, never their values. Copy `apps/cloud/.env.example` to `~/.config/akeru-cloud/staging.env` (and `local.env`) and fill it in. `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are required on every stage, `local` included; use the Clerk development instance for `local` and `staging`. The Slack manager, PostHog, `CLOUD_PUBLIC_URL`, and `KILL_SWITCH` values are optional. CI calls `alchemy` directly and takes the same names from GitHub environment secrets and variables.

### One-time setup

1. Create the GitHub environment `cloud-production`, and `cloud-staging` if you want to dispatch staging from CI.
2. In each, add these secrets:
   - `CLOUDFLARE_API_TOKEN`: an account token with edit access to Workers Scripts, D1, and Secrets Store. Alchemy keeps the state store's own token in Secrets Store.
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` from that stage's Clerk instance.
   - `SLACK_MANAGER_CLIENT_ID` and `SLACK_MANAGER_CLIENT_SECRET` from Akeru's Slack manager app, once it exists. Until then `slack.manager` flows answer `disabled`.
   - `POSTHOG_KEY` (optional).
3. Optional variables: `CLOUD_PUBLIC_URL` (defaults to the stage's workers.dev URL), `POSTHOG_HOST` (defaults to `https://us.i.posthog.com`), and `KILL_SWITCH`.
4. In Clerk, enable Google and email sign-in, and set `publicMetadata.role` to `"admin"` on admin users.
5. In the Slack manager app, add `<cloud>/v1/oauth/callback` as a redirect URL.

To pause hosted channels, set the `KILL_SWITCH` variable (or the value in `~/.config/akeru-cloud/staging.env` for staging) to `1` and redeploy. Inbound channel requests then get `503` and nothing is relayed.

## Tests

`vp test run` in `apps/cloud`, or `vp test run apps/cloud` from the repository root, covers the link flow, the connect endpoint's status codes, CSRF rules, route cap, Slack URL verification and relayed retries, the inbound body cap, byte-exact inbound forwarding and offline counting, OAuth state handling, the hub's socket protocol, and the admin gate. D1 is replaced by in-memory SQLite with the real migrations. The hub test replaces `cloudflare:workers` with the stub in `apps/cloud/test` through `vi.mock`, so no config alias is needed. `scripts/stageEnv.test.ts` covers how the deploy wrapper layers configuration files.

Heartbeats reuse a successful account and revocation check for at most 60 seconds. Route and OAuth commands check D1 freshly. Each socket allows a burst of 30 messages, replenishing one message per second; excess messages close the socket before database access.

The owner-only `cloud.forget` RPC removes local credentials and stops reconnecting without contacting the cloud. It does not revoke the remote environment. Settings exposes it separately from confirmed Disconnect.
