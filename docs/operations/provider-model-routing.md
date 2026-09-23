# Provider model routing verification

> For maintainers and operators. Using Akeru Bot? See [docs/user](../user/).

Akeru Bot routes each bot's saved model to its provider at turn time. This runbook verifies that
routing with real credentials: one live turn per provider, checked at the wire and in the trace
file. The automated suite covers the same assertions with mocked transports in
`apps/server/src/provider/Layers/AgentController.test.ts`
("per-driver wire-format model routing") and
`apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`.

## What routing means

The saved model travels one of two paths:

- **Mastra drivers** (Codex, Claude, Grok, Kimi For Coding, OpenCode Go): `AgentController` maps the
  saved slug to a wire model id — `openai/<model>`, `anthropic/<model>`, `xai/<model>`,
  `kimi-for-coding/<model>`, `opencode-go/<model>` — and calls `session.model.switch` on the
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

For every provider: pick the bot's model in the chat model picker, send a short turn, then confirm
the span attributes name the routed provider and the exact saved model.

```bash
# Span for a single turn: provider.kind and provider.model must match the saved selection.
jq -c 'select(.name | test("sendTurn|send-turn")) | {
  name, provider: .attributes["provider.kind"], model: .attributes["provider.model"]
}' "$TRACE_FILE" | tail -5
```

| Provider         | Saved model example              | Wire assertion                                                              |
| ---------------- | -------------------------------- | --------------------------------------------------------------------------- |
| Codex            | `gpt-5.6-sol`, effort `high`     | `provider.kind: codex`, `provider.model: gpt-5.6-sol`                       |
| Claude           | `claude-opus-4-6`, effort `max`  | `provider.kind: claudeAgent`, `provider.model: claude-opus-4-6`             |
| Grok             | `grok-4`                         | `provider.kind: grok`, `provider.model: grok-4`                             |
| Kimi For Coding  | `k2-thinking`                    | `provider.kind: kimi`, `provider.model: k2-thinking`                        |
| OpenCode         | `anthropic/claude-sonnet-4-5`    | `provider.kind: opencode`, model slug must keep its `provider/` prefix      |
| OpenCode Go      | `gpt-5.6-luna`                   | `provider.kind: opencodeGo`, `provider.model: gpt-5.6-luna`                 |

For the two OpenCode adapters, also confirm the request itself: standard OpenCode turns log the
`session.promptAsync` call with `model: { providerID, modelID }`; OpenCode Go turns go through the
Mastra transport, so the trace shows the `model.switch` to `opencode-go/<model>` inside the
`AgentController.sendTurn` span's events.

Note that `provider.model` is only annotated when the turn carried an explicit `modelSelection`.
Every bot-driven chat turn does, so the attribute should always be present in this check — a
missing `provider.model` on a `sendTurn` span means the turn went out with no selection at all.

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

If the wire model differs from the saved selection, that is a routing bug — Akeru never silently
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

Configure two bots on the same provider instance with different saved models (for example two
Codex bots on `gpt-5.6-sol` and `gpt-5.6-codex-mini`), send a turn to each, and confirm each
`sendTurn` span's `provider.model` matches its own bot. The sessions are independent — one bot's
model switch must never appear on the other's session.

## If a check fails

Capture the failing span (`jq` the trace file by `traceId`), note the saved `modelSelection` from
the `thread.turn.start` command's `orchestration.command_type` span, and compare it to
`provider.model` on the `sendTurn` span. File the mismatch against the owning driver in
`apps/server/src/provider/Drivers/`; the fix belongs at the adapter boundary, not in the
orchestration layer.
