# Kimi For Coding on the Mastra harness — live verification

> For maintainers and operators. Using Akeru Bot? See [docs/user](../user/).

Kimi For Coding runs entirely on Akeru's in-process Mastra harness (`AkeruMastraHarness` +
`AkeruKimiProvider`). It never spawns a provider CLI and never touches the legacy adapter bridge.
The automated suite covers this with mocked transports in
`apps/server/src/provider/Layers/AgentController.test.ts` ("Kimi Mastra normalization" and the
fake-transport end-to-end case) and
`apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts` ("Kimi never reaches the
legacy bridge"). This runbook verifies the same behaviors against a real Kimi For Coding
subscription. Each step lists the observable signal that proves the Mastra path handled it.

## Before you start

- A running Akeru environment with a Kimi For Coding subscription connected in
  Settings → Providers (OAuth device login, `kimi-for-coding`).
- The provider event log for the thread under test:
  `~/.akeru/userdata/logs/provider/events.<threadSegment>.log` (or
  `<worktree>/.akeru/userdata/logs/...` in a dev worktree). See
  [provider-model-routing.md](provider-model-routing.md) and
  [observability.md](observability.md) for the layout.
- One chat thread bound to a bot whose provider is Kimi For Coding.

Every event below is a `ProviderRuntimeEvent` written by `AgentController`; `provider` must be
`kimi` on each of them. If any step shows the provider session surviving a restart or a turn
routing through a spawned CLI, that is a defect — Kimi has no process to resume, so the Mastra
session must be rebuilt in memory and continue.

## 1. Full turn with a tool call

Send a turn that forces a tool call, for example "List the files in this directory and summarize
the top-level structure."

Expected, in order:

1. `turn.started` with `provider: kimi`.
2. `item.started` / `item.completed` pairs for each tool the model calls (`title` names the tool,
   `status: completed` on success).
3. `content.delta` events carrying the final answer text.
4. `turn.completed` with `payload.state: completed`.

If the model asks for approval first, approve it (see step 2 for the denial path) and let the tool
run to completion.

## 2. Approval denial

With the chat in `approval-required` mode, send a turn that requires a shell or write action, then
pick **Decline** on the approval card.

Expected:

- `request.opened` with `requestType: dynamic_tool_call` and `target` naming the tool.
- `request.resolved` with `payload.outcome: denied` and `actor: user`.
- `item.completed` for that tool with `payload.status: declined` — the tool never executes.
- The turn still finishes (`turn.completed`); the model may note the denial in its reply.

A denial that leaves the turn stuck in `waiting`, or that reaches the tool anyway, is a bug in
`AgentController.respondToRequest`, not in the Kimi transport.

## 3. Cancel mid-turn

Send a long-running turn (a large refactor or a command that runs for a while), then use the
stop/cancel control while it is still running.

Expected:

- `turn.completed` with `payload.state: interrupted` for the in-flight turn id.
- The session returns to `ready` — a following turn works without restarting anything.
- The harness calls `session.abort()` on the in-process Mastra session; there is no provider
  process to kill, so cancellation is immediate once the current model call resolves.

## 4. Restart and resume after server restart

This is the riskiest leg for Mastra drivers because the session lives in process memory.

1. Send a turn, let it complete.
2. Restart the Akeru server (`vp run dev` again, or restart the desktop app).
3. Open the same chat thread and send another turn.

Expected:

- The new turn runs normally: `turn.started` → content → `turn.completed`.
- The model and saved options survive the restart because they are re-resolved from the thread's
  saved `modelSelection` at `startSession` time, not from persisted provider state.
- No legacy-resume attempt appears: a real defect here would surface as a
  `ProviderUnsupportedError` or a validation failure naming the missing adapter.

## 5. Model switch between turns

1. Send a turn with the saved model (for example `k3-256k`).
2. Change the thread's model in the picker to another advertised Kimi model (`k3`,
   `kimi-for-coding`, or `kimi-for-coding-highspeed`). To use any other slug, first add it under
   the Kimi instance's custom models in Settings — the picker only offers advertised models plus
   configured custom models, and an unknown slug fails at the Kimi API.
3. Send a second turn in the same chat.

Expected:

- No session rebuild — the same chat keeps its history.
- `turn.started` on the second turn carries `payload.model` equal to the new slug.
- On the wire, `AgentController` calls `session.model.switch({ modelId: "kimi-for-coding/<model>" })`
  on the existing session. In the trace this appears inside the `resolveEngine` /
  `sendTurn` span attributes as `provider.model: <new slug>`.

## What "no legacy bridge" means operationally

The strongest proof that Kimi never touches `LegacyProviderBridge` is that none of these flows
can produce a `ProviderUnsupportedError` for `kimi` or a `ProviderValidationError` about a missing
binding. Those errors only exist on the adapter path. If you see one while the provider is Kimi,
capture the span and file it — the registry should have failed closed before any adapter was
resolved.
