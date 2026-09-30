# Self-hosted relay boundary

This document describes the relay protocol slice that is safe to implement without a central Akeru service. It is an internal contract, not a deployment guide for a public proxy.

## Boundary

`packages/contracts/src/relay.ts` defines protocol version `1`, a route binding, and an attach request. `packages/shared/src/relay.ts` validates those values without side effects or logging.

The route binding contains three values:

- `protocolVersion` must be a supported protocol version.
- `routeId` identifies the configured relay route.
- `environmentId` identifies the Akeru environment that owns the route.

An enrollment secret authorizes attaching a route. It is a separate credential from a pairing credential or a bearer session. The relay must not mint, substitute, or interpret environment sessions. After attachment, the environment's existing pairing and session authorization remains authoritative for HTTP and WebSocket operations.

## Validation order

An implementation must validate the route binding before accepting an attachment:

1. Reject an unsupported protocol version.
2. Reject a route ID that does not match the configured route.
3. Reject an environment ID that does not match the configured environment.
4. Compare the enrollment secret without including it in errors or logs.

`validateRelayAttachment` implements this order and returns only a small rejection reason. It does not accept request bodies, bearer tokens, or pairing tokens, and it does not establish transport confidentiality. The eventual transport still needs TLS or an equivalent protected channel, and the relay must forward authentication without logging credentials or bodies.

## Current limit

There is no relay listener, public directory, hosted proxy, enrollment command, or end-to-end secrecy claim in this slice. A future self-hosted relay can use the contract once it has an explicit transport and lifecycle owner, with tests for forwarding, reconnects, revocation, and TLS deployment.
