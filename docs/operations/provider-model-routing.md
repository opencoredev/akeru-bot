# Provider model routing verification

> For maintainers and operators. Using Akeru Bot? See [docs/user](../user/).

Akeru Bot routes each bot's saved model to its provider at turn time. This runbook explains
the evidence available for a live turn and its limits. Trace attributes expose the selection
on standard OpenCode's legacy bridge, but do not prove the effective wire model for Mastra drivers.
Mocked transport regressions verify wire-format routing in
`apps/server/src/provider/Layers/AgentController.test.ts`
("per-driver wire-format model routing") and
`apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`.

## What routing means

The saved model travels one of two paths:

- **Mastra drivers** (Codex, Claude, Grok, Kimi For Coding, OpenCode Go): `AgentController` maps the
  saved slug to a wire model id (`openai/<model>`, `anthropic/<model>`, `xai/<model>`,
  `kimi-for-coding/<model>`, `opencode-go/<model>`) and calls `session.model.switch` on the
  in-process Mastra session before `sendMessage`. Saved options such as Codex `reasoningEffort` and
  `serviceTier` ride in the session state's `modelOptions`; Claude `effort` is normalized inside the
  Claude transport.
- **Legacy bridge** (standard OpenCode): `ProviderService.sendTurn` forwards
  `modelSelection.model` unchanged into the OpenCode `session.promptAsync` call as
  `model: { providerID, modelID }` after `parseOpenCodeModelSlug` splits the `provider/model` slug.
  A slug without a `/` fails closed with `ProviderAdapterValidationError` instead of guessing a
  provider.

Two bots on the same provider instance each get their own Mastra session or adapter binding. The
saved model is resolved per thread from `resolveEngine`, so independent routing is covered by the
reactor test "routes two bots on the same provider instance to their own saved models".

## Before you start

You need a running Akeru environment with your own subscriptions or API keys connected in
Settings, and the local trace file. See [observability.md](observability.md) for the trace path;
for a normal launch it is `~/.akeru/userdata/logs/server.trace.ndjson` (or
`<worktree>/.akeru/userdata/logs/...` for a dev worktree).

```bash
TRACE_FILE=~/.akeru/userdata/logs/server.trace.ndjson
```

Each check below sends one ordinary chat turn and then inspects the spans for that thread.

## Per-provider checks

For standard OpenCode, pick the bot's model in the chat model picker and send a short turn.
The legacy `ProviderService.sendTurn` span annotates the provider and, when explicitly supplied,
the saved model selection. Compare these attributes with your selection:

```bash
# Standard OpenCode legacy bridge only; this is not a wire-payload assertion.
jq -c 'select(.name == "sendTurn" and .attributes["provider.kind"] == "opencode") | {
  name, provider: .attributes["provider.kind"], model: .attributes["provider.model"]
}' "$TRACE_FILE" | tail -5
```

For Codex, Claude, Grok, Kimi For Coding, and OpenCode Go, `AgentController.sendTurn` does not
currently annotate `provider.kind` or `provider.model`. Its `runMastra("model.switch", ...)`
call is not a traced event or child span. Missing attributes do not establish that a turn lacked
a model selection. A saved bot engine is configuration, not proof of the model sent on the wire.

Until that instrumentation exists, use the "per-driver wire-format model routing" tests in
`apps/server/src/provider/Layers/AgentController.test.ts` and the independent-bot routing tests in
`apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`. These are mocked regression
checks, not evidence that a live provider accepted a particular model.

Runtime events such as `turn.started` (with `payload.model`, the model the session is actually
using) and Codex's `model.rerouted` (`fromModel`/`toModel`) do not land in
`server.trace.ndjson` — they are canonical `ProviderRuntimeEvent`s written to the provider event
stream instead. Inspect them in the chat's activity feed or in the per-thread provider event
NDJSON: the logger writes one file per thread as
`~/.akeru/userdata/logs/provider/events.<threadSegment>.log` (plus `events._global.log` for
thread-free events).

```bash
# models the runtime actually reported for turns on this machine
jq -c 'select(.type == "turn.started" or .type == "model.rerouted") |
  { type, model: .payload.model, from: .payload.fromModel, to: .payload.toModel }' \
  ~/.akeru/userdata/logs/provider/events.*.log | tail -10
```

If the wire model differs from the saved selection, that is a routing bug. Akeru never silently
substitutes a model. A Codex-side reroute emits a `model.rerouted` runtime event instead of hiding
the change; check `fromModel`/`toModel` in the provider `events.*.log` files.

## Fail-closed checks

Routing must fail, not fall back, when the saved selection cannot run:

- **Disabled instance.** Toggle the instance off in Settings → Providers, send a turn. The turn
  fails with `ProviderValidationError` naming the disabled instance; no provider span appears.
- **Missing credential.** Disconnect the subscription or remove the instance API key for an
  isolated instance, then send a turn. `resolveEngine` fails with
  `AgentControllerUnsupportedEngineError` whose cause names the missing transport (for example
  `This Codex instance needs OPENAI_API_KEY` or
  `This Claude instance needs an API key or auth token`). The UI shows the typed turn-start failure
  and the provider list reports the matching unavailability category
  (`missing-login`, `expired-login`, `unsupported-model`, `limit-reached`, `usage-cap`, or
  `temporary-failure`).
- **Unsupported model slug (OpenCode).** A saved OpenCode selection without the
  `provider/model` prefix fails with `ProviderAdapterValidationError`
  ("must use the 'provider/model' format") before any prompt is sent.

## Multi-bot check

Configure two standard OpenCode bots on the same provider instance with different saved models,
send a turn to each, and compare each legacy span's `provider.model` with its own bot's selection.
For Mastra drivers, use the mocked reactor test "routes two bots on the same provider instance
to their own saved models". The current trace cannot establish live per-bot wire routing.

## If a check fails

Capture the failing span (`jq` the trace file by `traceId`) and record the bot's saved selection.
For standard OpenCode, compare it to `provider.model` on the legacy `sendTurn` span. For Mastra
drivers, record available runtime events and reproduce the mismatch in the mocked wire-format
tests rather than treating absent trace attributes as a routing failure. File the mismatch against the owning driver in
`apps/server/src/provider/Drivers/`; the fix belongs at the adapter boundary, not in the
orchestration layer.
