# Akeru Cloud: environment side

> For maintainers. Using Akeru Bot? See [Akeru Cloud](../user/akeru-cloud.md).

Akeru Cloud is an optional hosted service. This page covers the environment's half: how it links to an account, keeps one socket open, and hands relayed traffic to features. The wire contract lives in `packages/contracts/src/cloud.ts`. Every change there must stay additive, because deployed clouds and environments upgrade independently.

The server code lives in `apps/server/src/cloud/`:

| Service              | Owns                                                                       |
| -------------------- | -------------------------------------------------------------------------- |
| `CloudAccount`       | Link state, the device-link flow, and the stored credential.               |
| `CloudConnection`    | The outbound socket, reconnects, heartbeat, requests, and message routing. |
| `HostedChannelRelay` | Routing `channel.inbound` requests to a channel runtime webhook.           |

All three are built in `server.ts` as `CloudLayerLive`. While unlinked they hold state only and open no connections, so an environment that never links pays nothing.

## Link state and the credential

`CloudAccount` publishes `CloudLinkStatus`: `unlinked`, `linking`, `linked` with a `connection` of `connecting`, `connected`, or `offline`, and `revoked`.

`link` posts `CLOUD_LINK_START_PATH`, sets `linking`, and polls `CLOUD_LINK_POLL_PATH` on a background fiber at the cloud's interval. `approved` stores the credential and sets `linked`. `expired`, `denied`, or the local expiry time return to `unlinked`. A failed poll is logged and retried until expiry. `cancelLink` interrupts the poller.

`link`, `cancelLink`, `unlink`, and approval share one mutex. Approval saves the token and publishes `linked` as one uninterruptible step under it. A cancel that holds the mutex first stops the poller before anything is saved; a cancel that arrives during approval waits and returns `linked`. Either way the stored token and the status agree.

The environment token, environment id, account email, and the origin of the cloud that issued the token are stored together as one JSON entry named `akeru-cloud-link` in `ServerSecretStore`. The token must never reach status, settings, orchestration events, logs, analytics, diagnostics, URLs, or client state. It goes only into the socket's `Authorization: Bearer` header. `revoked` is held in memory, so after a restart a revoked environment reads as `unlinked`.

### The cloud origin

`CloudAccount.cloudUrl` picks the origin for a new link. The whole device flow uses the origin resolved when it starts:

1. The server setting `akeruCloudUrl`, when it is set to anything other than `DEFAULT_AKERU_CLOUD_URL`.
2. The `AKERU_CLOUD_URL` environment variable.
3. `STAGING_AKERU_CLOUD_URL` when the server runs from source in dev, which the server knows because the dev runner sets a dev web URL (`VITE_DEV_SERVER_URL`).
4. `DEFAULT_AKERU_CLOUD_URL`, the production cloud, for packaged builds.

Steps 2 to 4 are resolved once at startup by `cloudUrlFallbackLayer` in `server.ts`. To point a dev server at a local Worker, start it with `AKERU_CLOUD_URL=http://localhost:1337 vp run dev`. The `AkeruCloudUrl` schema accepts an HTTPS origin, or HTTP for loopback only, for both the setting and the variable. `ServerSettingsRpcPatch` omits the setting, so a client cannot redirect the token to another origin.

A token belongs to the cloud that issued it. The socket and unlink always use the stored origin, so changing the setting, the variable, or the dev default while linked has no effect until the user unlinks and links again. The production-default rule in step 1 only chooses where to link and can never send a token to another cloud.

A stored entry without the origin, or one that fails to decode for any other reason, reads as `unlinked` and its token is never sent. Linking again overwrites it.

## The socket

`CloudConnection` watches the account's credentials and runs one session per token, switching when the token changes and stopping when it clears. Each session:

1. Opens `${akeruCloudUrl}${CLOUD_ENVIRONMENT_SOCKET_PATH}` with `ws`/`wss` and the bearer header.
2. Sends `hello` with the server version, environment name, and `CLOUD_CAPABILITIES`. The list is empty for now: `hosted-channels` is advertised once a hosted channel runtime attaches to `HostedChannelRelay`.
3. Sets `connected` on `welcome` and refreshes the account email from it.
4. Pings every 20 seconds and closes the socket after 50 seconds without an inbound message.
5. On close, sets `offline` and waits before reconnecting. The delay is half fixed and half random, doubling from 1 second to a 60-second cap. A session that reached `welcome` resets the backoff.

Inbound frames are decoded with `CloudServerMessage`. Undecodable frames are dropped with a debug log, so a newer cloud cannot crash an older environment. `revoked` clears the credential, sets `revoked`, and ends the session without reconnecting.

The Node socket transport reads a refused upgrade’s HTTP status directly and passes it to `onClose`. `401` (unknown token) and `410` (revoked environment or disabled account) from the stored origin are treated like `revoked`. Other statuses and connection failures reconnect with backoff.

`CloudConnection.unlink` backs the `cloud.unlink` RPC. It sends `environment.unlink`, waits up to 5 seconds for the result, then forgets the token whether or not the cloud answered. Offline, the environment still unlinks locally and the account page can revoke it later.

The socket factory is the `CloudSocketFactoryRef` reference. Production uses the runtime's `WebSocket`, which accepts `{ headers }` in both Node and Bun. Tests inject a fake.

## Adding a feature

Features never open their own connection. They use two seams on `CloudConnection`:

- `request(message)` sends a message that carries a `requestId`, generates the id, and waits up to 15 seconds for the matching `result`. It fails with `CloudRequestError` as `offline` when no session has been welcomed, `timeout`, or `rejected` with the cloud's `CloudErrorCode`.
- `register(kind, handler)` handles a server message kind until the registering scope closes. Handlers run on the layer scope, so a socket drop does not interrupt one mid-flight.

A new feature adds message kinds to `cloud.ts`, advertises a capability in `CLOUD_CAPABILITIES`, and registers its handlers in its own layer.

## Hosted channel relay

`HostedChannelRelay` registers for `channel.inbound` and `channel.missed`. A channel runtime entry attaches with `attach(routeId, { webhook })` and leaves with `detach(routeId)`. For each forwarded request the relay builds a standard `Request` and calls the entry's `webhook`, the same function WhatsApp serves over HTTP. The URL uses a placeholder origin and the route path. The body is decoded from `bodyBase64` to the exact bytes the provider sent. Hop-by-hop headers are dropped, and signature headers and the body pass through untouched so the adapter can verify them.

The forwarded path must stay below the route. The relay drops a request whose path has a `.` or `..` segment (plain or percent-encoded), an encoded `/` or `\` inside a segment, a `#`, a `\`, or a leading `//`, and checks that the built pathname still starts with the route prefix.

The cloud relays Slack retries. The Chat SDK Slack adapter drops a retry whose `event_id` it already dispatched, so the relay does not dedupe. There is no reply path over the socket, so the webhook's `Response` is logged when it is not OK and otherwise discarded.

`channel.missed` is logged and summed per route in memory, readable through `missed(routeId)` until the route detaches or the server restarts. Nothing shows it in a client yet.

## Client surfaces

RPCs, all in `packages/contracts/src/rpc.ts`:

| Method                 | Scope                |
| ---------------------- | -------------------- |
| `cloud.getStatus`      | `orchestration:read` |
| `subscribeCloudStatus` | `orchestration:read` |
| `cloud.linkStart`      | `access:write`       |
| `cloud.linkCancel`     | `access:write`       |
| `cloud.unlink`         | `access:write`       |

Linking attaches the environment to an outside account, so the mutations require an administrative session. See [environment auth](./environment-auth.md).

Web and desktop show the section in `AkeruCloudSettings.tsx` and add Connect or Disconnect to the command palette based on status. Mobile uses `SettingsAkeruCloudRouteScreen.tsx`. Both render from `cloudViewModel` and `CLOUD_COPY` in `@akeru/client-runtime/cloud-presentation`.

## Tests

`apps/server/src/cloud/AkeruCloud.test.ts` runs the three services against a fake HTTP client and an injected socket factory under `TestClock`. It covers the link flow, expiry, cancel and unlink (including the cancel-during-approval race), the cloud origin fallback, links staying on the cloud that issued them, entries without an origin reading as unlinked, the hello handshake, backoff bounds, heartbeat timeout, revocation by message and by `401`/`410` handshake, unlink over the socket and offline, request correlation and timeout, relay dispatch with byte-exact bodies, and path rejection.
