# Environment authentication

> For maintainers. Using Akeru Bot? See [remote access](../user/remote-access.md).

Each Akeru Bot server authenticates its own clients. There is no hosted account or third-party trust
boundary.

## Scopes

| Scope                   | Permission                                              |
| ----------------------- | ------------------------------------------------------- |
| `orchestration:read`    | Read projects, threads, configuration, and diagnostics. |
| `orchestration:operate` | Change server and orchestration state.                  |
| `terminal:operate`      | Open and control terminals.                             |
| `review:write`          | Submit review operations.                               |
| `access:read`           | List pairing links and client sessions.                 |
| `access:write`          | Create and revoke pairing links and sessions.           |

Ordinary pairing credentials grant the four orchestration, terminal, and review scopes.
Administrative credentials also grant both access scopes.

## Bootstrap methods

The server accepts these short-lived bootstrap methods:

- `desktop-bootstrap` for the trusted local desktop handoff.
- `one-time-token` for manual pairing.

A bootstrap credential is not a steady-state session. The client exchanges it for either a browser
cookie or a bearer access token.

## Session methods

The server advertises two session methods:

- `browser-session-cookie` for a browser served by that server.
- `bearer-access-token` for saved remote, mobile, desktop, and SSH connections.

`POST /oauth/token` uses the OAuth token-exchange request shape. Requested scopes must be a subset
of the bootstrap grant. A successful response has this form:

```json
{
  "access_token": "<opaque session token>",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "orchestration:read orchestration:operate terminal:operate review:write"
}
```

The server stores client presentation metadata for the authorized-clients list. IP address and user
agent come from the request. Presentation fields do not grant access.

## WebSocket tickets

`POST /api/auth/websocket-ticket` accepts an authenticated session and returns a short-lived
WebSocket ticket. The client sends its bearer token in the HTTP authorization header, then places
only the ticket in the WebSocket URL.

Each RPC method maps to one required scope in
`apps/server/src/auth/RpcAuthorization.ts`. Creating a ticket does not authorize every RPC.

## Pairing records

Manual pairing links are single-use and expire. Desktop bootstrap credentials remain reusable for
the desktop process lifetime so a renderer reload can recover.

The database can contain legacy proof-bound pairing rows from an older release. The bearer-only
runtime does not consume or list those rows. It does not downgrade them to bearer credentials.

## Upgrade behavior

The scoped-auth migration invalidates older role-based links and sessions. Clients must pair again.
The server does not map old owner or client roles to new scopes.
