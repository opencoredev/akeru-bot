# Remote architecture

> For maintainers. Using Akeru Bot? See [remote access](../user/remote-access.md).

A client connects to one Akeru Bot server over HTTP and WebSocket. The server owns providers,
projects, threads, terminals, git, and filesystem access. Remote access changes how the client
reaches the server. It does not split that runtime.

## Connection targets

The shared client runtime defines three target types:

| Target                    | Use                                                         |
| ------------------------- | ----------------------------------------------------------- |
| `PrimaryConnectionTarget` | The platform-managed local server.                          |
| `BearerConnectionTarget`  | A saved server reached through direct HTTP and WebSocket.   |
| `SshConnectionTarget`     | A server started and forwarded by the desktop SSH launcher. |

Tailscale uses the bearer target. It supplies a reachable address but does not add another
connection type.

A saved target is local to one client. The server remains the source of projects, threads, settings,
and provider state.

## Pairing

The server issues a short-lived pairing credential. A client exchanges it for a scoped bearer
session and saves the connection locally. The pairing credential is single-use for ordinary links.

A pairing URL contains the server address and keeps the credential in the URL fragment. The client
removes the credential from browser history after the exchange. The client then connects directly to
that server. No Akeru service proxies the session.

The server may advertise loopback, LAN, Tailscale, or custom HTTPS endpoints. Clients treat those
addresses as hints. A connection attempt is the final reachability check.

## Direct and Tailscale access

Direct LAN and custom HTTPS addresses use the same bearer flow. HTTPS pages can connect only to
HTTPS and WSS servers because browsers block mixed content.

Tailscale Serve can publish the local server through an HTTPS MagicDNS address. The server manages
that mapping when the user enables it. The resulting address still uses ordinary pairing and bearer
authorization.

## Desktop SSH access

The desktop app can start or reuse Akeru Bot on an SSH host and open a local port forward. The
remote host owns all server state. The desktop stores an `SshConnectionTarget` and reconnects
through the forwarded endpoint.

SSH is a desktop capability because it requires local process and SSH access. Web and mobile can use
a directly reachable server after normal pairing.

## Environment identity

Each server stores a stable `environmentId` in its state directory. Clients use that identifier to
reject endpoints that point at a different server than the saved target.

Repository identity may group related clones in the interface. It never changes routing. A project
always belongs to one environment.

## Connection ownership

`packages/client-runtime` owns target resolution, retries, transport lifetime, cached projections,
and environment-scoped commands. Web and mobile provide platform storage and lifecycle signals.
React components do not create sockets or retry loops.

See [connection runtime](./connection-runtime.md) and
[environment authentication](./environment-auth.md) for the detailed contracts.
