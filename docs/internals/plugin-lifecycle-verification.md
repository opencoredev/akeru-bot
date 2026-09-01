# Plugin lifecycle verification

Milestone 13 keeps catalog discovery separate from connection verification. An entry stays non-installable until its real install, authentication, safe read, approved write, disable, reconnect, and removal lifecycle passes. `verification-pending` means that local lifecycle proof is missing. `approval-pending` means an external vendor, administrator, allowlist, or first-party connector is still required.

`plugins/lifecycle-matrix.test.ts` is the catalog gate. It fixes the directory at 52 IDs, keeps four verified `builtin-<id>` recipes installable, and keeps the other 48 entries pending. It also checks Featured order, consequential approval coverage, broker identity, Custom MCP independence, legacy built-in display, and the Computer Use, Executor, Typefully, Paper, and PayPal blockers.

## Runtime proof

The lifecycle matrix does not copy runtime tests. These focused tests own the runtime behavior:

- `apps/server/src/orchestration/Layers/McpServerRegistry.test.ts` covers create, update, disable, enable, delete, missing IDs, and independent raw MCP state.
- `apps/server/src/provider/Layers/AgentController.test.ts` covers selected MCP registration, exact tool-to-server attribution, startup failure, and request failure or recovery at the runtime event boundary.
- `apps/server/src/subscription-auth/service.test.ts` persists MCP failure and recovery without tool output or tokens.
- `apps/server/src/subscription-auth/snapshot.test.ts` keeps a built-in MCP detected until a real request passes, reports healthy and disabled state, and lists dependent bots.
- `apps/server/src/bot-inbox/connectorIncidents.test.ts` covers provider and MCP first-request failure, recovery, and stale dependent cleanup.

Bot-facing MCP controls use the same session-scoped Mastra `McpManager`. `GetMcpServerStatus` returns the manager connection plus persisted request evidence. `TestMcpServer` and `ReconnectMcpServer` use the manager's real per-server reconnect result, then update the same health and inbox records. A connected manager without a completed request or connection test reports `not-run`, not healthy.

Routine pausing remains an explicit dependency on the routine runtime in `t3code/routines-and-skills` commit `e77798657`. That branch owns durable connector dependencies and pause commands. Until it lands, MCP tool results return an empty `dependentRoutines` list and do not claim that a routine paused. Bind its repository and pause command at `AkeruMcpHealthHandlerOptions.getDependencies` and `onFailure`. Do not add a second routine store here.

Run the matrix with the catalog, schema, runtime, and validator checks. Do not call a vendor endpoint from automated tests.

## Vendor status

This local run did not perform a real Context.dev or Zernio connection lifecycle. Context.dev keeps its existing available identity; this run does not recertify it. Zernio stays Featured rank 2 and `verification-pending` until its OAuth and connection lifecycle passes.

Executor now declares its official hosted OAuth endpoint, but stays pending until that lifecycle passes. Typefully stays pending until its OAuth lifecycle passes. Paper stays pending until its loopback desktop lifecycle passes. PayPal stays pending until its first-party OAuth and payment lifecycle passes. No entry can move to available based on a manifest check, HTTP probe, or vendor documentation alone.
