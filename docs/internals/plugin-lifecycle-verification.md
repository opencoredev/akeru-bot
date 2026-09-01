# Plugin lifecycle verification

Milestone 13 keeps catalog discovery separate from connection verification. An entry stays non-installable until its real install, authentication, safe read, approved write, disable, reconnect, and removal lifecycle passes. `verification-pending` means that local lifecycle proof is missing. `approval-pending` means an external vendor, administrator, allowlist, or first-party connector is still required.

`plugins/lifecycle-matrix.test.ts` is the catalog gate. It fixes the directory at 52 IDs, preserves the five existing `builtin-<id>` recipes, and keeps the other 47 entries pending. It also checks Featured order, consequential approval coverage, broker identity, Custom MCP independence, legacy built-in display, and the Computer Use, Typefully, Paper, and PayPal blockers.

## Runtime proof

The lifecycle matrix does not copy runtime tests. These focused tests own the runtime behavior:

- `apps/server/src/orchestration/Layers/McpServerRegistry.test.ts` covers create, update, disable, enable, delete, missing IDs, and independent raw MCP state.
- `apps/server/src/provider/Layers/AgentController.test.ts` covers selected built-in installation, MCP startup and disconnect, protected actions, exact one-use approvals, secret redaction, and built-in plugin attribution.
- `apps/server/src/subscription-auth/service.test.ts` records MCP failure and recovery only from real tool requests.
- `apps/server/src/subscription-auth/snapshot.test.ts` keeps a built-in MCP detected until a real request passes, reports healthy and disabled state, and lists dependent bots.
- `apps/server/src/bot-inbox/connectorIncidents.test.ts` covers first-request failure, reconnect or request recovery, and removal of a dependent bot or provider status.

Run the matrix with the catalog, schema, runtime, and validator checks. Do not call a vendor endpoint from automated tests.

## Vendor status

This local run did not perform a real Context.dev or Zernio connection lifecycle. Context.dev keeps its existing available identity; this run does not recertify it. Zernio stays Featured rank 2 and `verification-pending` until its OAuth and connection lifecycle passes.

Typefully stays pending until its OAuth lifecycle passes. Paper stays pending until its loopback desktop lifecycle passes. PayPal stays pending until its first-party OAuth and payment lifecycle passes. No entry can move to available based on a manifest check, HTTP probe, or vendor documentation alone.
