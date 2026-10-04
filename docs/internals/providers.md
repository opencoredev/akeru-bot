# Provider architecture

> For maintainers. Using Akeru Bot? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. Akeru Bot supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with seven entries:

| Driver kind    | Driver source                                    |
| -------------- | ------------------------------------------------ |
| `codex`        | [`Drivers/CodexDriver.ts`][codex]                |
| `claudeAgent`  | [`Drivers/ClaudeDriver.ts`][claude]              |
| `grok`         | [`Drivers/GrokDriver.ts`][grok]                  |
| `kimi`         | [`Drivers/KimiDriver.ts`][kimi]                  |
| `opencode`     | [`Drivers/OpenCodeDriver.ts`][opencode]          |
| `opencodeGo`   | [`Drivers/OpenCodeGoDriver.ts`][opencode-go]     |
| `customOpenai` | [`Drivers/CustomOpenaiDriver.ts`][custom-openai] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds a
provider instance in a child scope. The five subscription drivers and Custom API supply a Mastra
connection; standard OpenCode supplies a legacy adapter. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Settings calls a provider instance an account. **Add account** on a provider's page creates another
instance of that page's driver; it never asks for a driver. Subscription accounts only take a name and
sign in from their card afterwards. The dialog does not show the inherited CLI fields (binary path,
home paths, launch arguments), because Mastra-routed drivers do not start the CLI to run turns.
Custom API asks for a service, a name, then its address and key.

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Desktop chat does not call `ProviderService` directly from orchestration. The command reactor calls
Akeru's [`AgentController`][controller]. Codex, Claude, Grok, Kimi, OpenCode Go, and Custom API threads run
through Akeru's custom Mastra Core controller and call `Session.sendMessage()`. The backing agent is a general-purpose Akeru assistant
with Akeru-owned observational memory, workspace, tools, approval policy, and lifecycle. Akeru builds
workspace and enabled plugin tools per thread, and resolves the selected subscription model through
the exact provider instance's private transport descriptor. Explicit instance credentials and base
URLs take precedence and never fall back to provider-wide credentials. AgentController
maps Mastra message, tool, approval, usage, completion, and error events to
`ProviderRuntimeEvent`.

All active provider paths receive bot-owned Markdown memory and participate in scope-specific
review accounting. Mastra refreshes the files before turn admission; standard OpenCode carries
them in its per-prompt system context. See [Memory architecture](memory.md).

### Runtime seam

AgentController is an Effect layer, but Mastra, the tool runtime, delegation, and memory work are
Promise-based. [`AkeruRuntimeSeam`][seam] is the only place where those callers re-enter the
controller's Effect runtime. The layer builds it once, and every fiber it starts joins a `FiberSet`
owned by the layer scope, so stopping the layer interrupts in-flight work.

- `runPromise` is for Promise callbacks that need an Effect result, such as Mastra tool handlers and
  approval callbacks. It resolves in the same microtask order as `Effect.runPromiseWith`, which turn
  admission relies on.
- `fork` and `forkPromise` start background work: observational memory, turn dispatch and
  admission, worker and delegation settlement after a turn, and auto-approval of allowed tools. A
  failure is logged as a warning with the thread, turn, or tool context. `forkPromise` passes the
  rejection to `onFailure` first so the controller can fail the turn or publish `runtime.error` as
  before. Interruption is not logged.
- Outbound calls from Effect into a Promise library go through `runMastra`, which types the failure
  as `AgentControllerRuntimeError`.

Some runtimes arrive after construction, because orchestration is built after the controller.
The channel, plugin, bot-state, and delegation runtimes, plus the orchestration handle that workers
use, live in one `Ref` that `configurePluginRuntime` and `configureDelegation` update. They are not
mutable `let` bindings.

## Catalog tool parity

The typed Akeru catalog is advertised only by the Mastra controller. Codex, Claude, Grok, Kimi
For Coding, and OpenCode Go receive the same catalog and approval semantics through that controller,
while standard OpenCode remains on the legacy bridge and does not advertise catalog-only tools. A
legacy-path provider must not claim WebSearch, WebFetch, image generation, or MCP account mutations
unless it is routed through the shared Mastra runtime.

Mastra sessions wire four network and media catalog backends. `AkeruWebFetch.ts` owns WebFetch.
Each hop is resolved once and rejected if any address is loopback, private, link-local, CGNAT,
multicast, or IPv4-mapped. The socket is then pinned to the validated address through a custom
`lookup`, so the connection never asks DNS again and a rebinding resolver cannot swap the target.
Redirects are followed up to five times, and every hop is parsed and resolved again. Bodies stream
with a 2 MB cap and end with a truncation marker when cut. Each request has an idle timeout and an
overall deadline.

WebSearch is advertised but reports `status: "unavailable"` with no results. The Mastra providers
expose no native search call that Akeru can invoke, and Akeru has no search index of its own, so the
tool says so and suggests WebFetch instead of inventing results.

GenerateImage calls `runImageGenerationTool` in the image generation runtime, the same entry the
`generate_image` MCP tool uses for legacy-bridge sessions. The tool is listed only when ChatGPT or
Grok images are enabled in Settings. Images are saved as chat attachments and posted into the chat;
the tool result carries artifact metadata only. GenerateImage needs production approval.

SetMcpInstructions dispatches `mcp-server.instructions.set`. The guidance is stored on the MCP
server record, is limited to 4,000 characters, and an empty string clears it. Mastra appends every
saved guidance line to the system prompt from the next turn on. MCP mutations exist only after the
plugin runtime is configured with a snapshot reader and dispatcher. AddMcpServer and RenameMcpAccount
decode their input with the contract schema, so a stdio add without a command fails as a schema
error before anything is dispatched. UninstallMcpServer and RemoveMcpAccount read the snapshot
first, return `dependentBots` (active bots that had the server on, the same rule as MCP health
dependencies), and follow `mcp-server.delete` with a `bot.update` for every bot, archived or not,
whose `disabledMcpServerIds` still names the deleted server. Legacy bridge sessions don't
receive the guidance. Environment exports carry it on each MCP server record.

`CloudAgent` was dropped from the catalog specification after Cursor was removed as a supported
provider. A Cursor account would have introduced a separate credential boundary and no longer fits
Akeru's provider-neutral catalog.

Mastra keeps approval callbacks enabled in every runtime mode. `AgentController` auto-approves
`ask_user`, then converts its suspension into a user-input request. In automatic mode, it approves
only the routine actions allowed by the selected mode. It always asks before an MCP tool call or an action
that can write through MCP, sends, pays, deletes, changes production, exposes secrets, publishes, signs, refunds, or changes
an account. Unknown mutating intent also asks. The pending approval map binds the response to the
exact tool-call ID, deletes that entry before execution, and treats session-wide or permanent answers
as one-use approval.

Standard OpenCode is the sole compatibility runtime behind [`LegacyProviderBridge`][bridge]. Its
server API exposes an OpenCode-owned agent session, not a raw model transport, so wrapping it would
still leave two agent loops. OpenCode Go is the direct model transport for the unified Akeru harness.
A provider change stops the active runtime and starts the selected provider without reusing an
incompatible resume cursor. AgentController never falls back to a provider-owned loop when a Mastra
session is absent.

The legacy OpenCode adapter keeps only per-message text state for later PATCH edits. Tool input and
output are emitted as lifecycle events and are not retained in the session map. Individually removed
text parts and whole removed messages are discarded from retained state. OpenCode Go stays on Mastra.

The legacy OpenCode adapter owns child sessions created for subagents. Permission and question events
from a descendant session are routed onto the parent thread after ancestry is verified. Stop and
interrupt walk the child tree and abort every descendant, not only the parent. Unrelated OpenCode
sessions are left alone. Full-access threads auto-reply permission asks once, without a dialog, and
fall back to the dialog if that reply fails. OpenCode Go stays on the Mastra controller and does not
use this adapter path.

Standard OpenCode discovery probes `opencode --version` for at most four seconds. The probe command
runs in its own process group so a hanging wrapper cannot keep provider status running after the
timeout. Inventory CLI commands (`models --verbose`, `agent list`, `debug skill`) run one at a time.
A process-wide permit serializes the full inventory sequence, including retries, across concurrent
provider checks and separately constructed OpenCode runtimes, because they share one SQLite database.
OpenCode Go stays on the Mastra controller and does not use this CLI probe path.

Legacy OpenCode rollback targets the first removed assistant message and then reads the native
revert boundary. OpenCode keeps reverted messages in the transcript until the next prompt, so
`readThread` stops at `session.revert.messageID` rather than slicing the local copy. OpenCode Go
stays on Mastra and does not use this adapter path.

### Custom API

Custom API (`customOpenai`) is not a subscription. Each instance points at one OpenAI-compatible
endpoint, and Mastra reaches it through the `custom-openai/` model prefix with
`createOpenAICompatible`. The base URL comes from the instance's `CUSTOM_OPENAI_BASE_URL` variable or
its `baseUrl` config. The optional key comes only from the instance's sensitive
`CUSTOM_OPENAI_API_KEY` variable, never from the process environment, so a process-wide key is
never sent to an arbitrary URL. A base URL alone makes the instance ready, because local servers
such as Ollama take no key.

The web settings write that key for the user. The add dialog offers presets from
`apps/web/src/components/settings/customApiPresets.ts` that fill `baseUrl` and the instance name,
and an **API key** field that saves `CUSTOM_OPENAI_API_KEY` as a sensitive variable. Presets are a
client convenience: the server stores only the URL, and the card matches the URL back to a preset
to word its key hint. A key is bound to its endpoint on the client: switching presets in the dialog
clears the draft key, and a card edit that moves the effective URL (the `CUSTOM_OPENAI_BASE_URL`
variable when set, `baseUrl` otherwise) to another host, or from HTTPS to HTTP, drops the stored key
in the same settings update, so the next probe never sends it to the new service. A redacted
override cannot be read, so any change to it, or a `baseUrl` move behind it, drops the key too. When
the variable repeats, the last row wins, as it does in the driver. A probe answered with 401 or 403
reports auth status `unknown`: the card stops showing the instance as connected, but preflight still
lets turns through, because a scoped key can be refused `/models` and still chat.

The model list is `GET {baseUrl}/models` plus the instance's hand-added models. Discovery is
optional: a failed or unreadable probe keeps the last good catalog and reports a warning naming only
the endpoint origin. Disabled instances never probe. The registry drops endpoint models only after a
probe settles, and never retains a hand-added model the user removed. Until a probe settles, a
hand-added model the last good catalog also listed keeps its discovered mark, so removing the
hand-added copy leaves the endpoint's model in place.

### Harness-native readiness

Codex, Claude, and Grok use `HarnessProviderStatus.ts`, not their CLI health checks, to publish
readiness. Like Kimi and OpenCode Go, they report the bundled runtime as installed even when no
provider binary exists. The initial snapshot and each refresh reload `SubscriptionAuthService`
from the environment's `subscription-auth.json`. A connected saved credential makes the instance
ready; a missing credential reports unauthenticated and asks the user to connect in Settings.

The model list comes from the [model catalog](#model-catalog) and `ModelCatalog.applyModelCatalog`.
Codex combines catalog IDs with bundled and historical compatibility models, and takes names,
reasoning efforts, and Fast availability from the catalog entry. Models the catalog does not list
fall back to the harness SDK's thinking levels and keep the Standard and Fast tiers. Catalog
efforts the SDK would silently downgrade, such as Max on older GPT aliases, are not offered. The catalog
classifies models as current or legacy; it is not an exhaustive allowlist. The OAuth transport
forwards the selected ID to the Codex API without a local catalog restriction. Account access is
still checked by the provider when a request runs. Claude merges catalog additions into its
built-in capability catalog without dropping historical models. A Claude model newer than the
build inherits the capabilities of the newest built-in model in its family. Grok includes its API model IDs
alongside catalog additions. It labels the compatibility `grok-build` selection as Grok 4.7 and maps it to `grok-4.7` in
`mastraModelId`, because the product slug is not an API model ID. Keeping the selection slug lets
existing bots and the default model pass catalog validation. Custom models are retained.

Successful credential mutations through poll, completion, and logout RPCs reconcile default
provider settings and refresh each affected saved-credential instance before returning. The
registry publishes the updated snapshot immediately, including for named instances and when
periodic health refresh is disabled.

Explicit connection variables or a custom home disable saved-credential fallback. Codex then
requires `OPENAI_API_KEY`, Claude requires `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or
`CLAUDE_CODE_OAUTH_TOKEN`, and Grok requires `XAI_API_KEY` in the instance's explicit environment.
A CLI login or custom CLI home alone cannot make that instance ready. Ambient credentials remain
available to saved-credential instances, matching the harness's transport precedence.

`HarnessTextGeneration.ts` generates chat titles and branch names through
`resolveAkeruMastraModel`, the same transport resolver as turns. It reloads saved credentials for
each operation and preserves instance scoping, Codex reasoning effort and service tier, and Claude
effort and context-window selections. Claude's 1M context selection uses the same `[1m]` model
suffix in turns and writing requests. The transport strips this CLI-style suffix from the API
model ID and sets the extended-context beta header for API keys and OAuth alike.
Each writing operation has a 180-second deadline and aborts
the generation request when it expires. Stored
image attachments are resolved through the attachment store and sent as multimodal image parts,
not just filenames. Invalid or unreadable image attachments are skipped; available images and
text still reach generation.
It does not spawn a provider CLI. These drivers no
longer construct legacy adapters. CLI skill catalogs and maintenance remain optional extras;
catalog failures do not fail a workspace snapshot or change readiness. A missing Grok CLI stays
silent; other skill discovery failures are logged as warnings. Claude still reads skill
files directly, without a CLI. Codex's CLI-only skills and Claude's CLI slash-command discovery are
not part of readiness snapshots. Version checks are skipped when there is no CLI version.

### Backup subscription accounts

A subscription provider can have several linked accounts. The first sign-in is account `default`,
stored under the bare provider key in `subscription-auth.json`; each added account gets an
`acct-<hex>` id stored under `account:<provider>:<id>`. Separately named provider instances keep
their own `instance:<provider>:<instanceId>` key and never join the backup order.

`SubscriptionAccountState` (`apps/server/src/subscription-auth/accountState.ts`) owns the order,
persisted next to the credentials as `subscription-auth.json.accounts`. Credential reads for the
default instance resolve to the first ready account: one is skipped while its `nextRetryAt` is in
the future or its last failure was a revoked sign-in. When a request fails with a usage-limit
message, `accountLimits.ts` benches that account until the reset time the provider gave, or for an
hour. Every credential read takes the thread id, and outcomes are recorded on the account that
served that thread, so concurrent chats on different accounts do not claim each other's failures.
Order and health files are re-read when another server process rewrites them.

`SubscriptionAuthStatuses.linkedAccounts` lists every linked account in order with `accountId`,
`active`, and `plan`. `subscriptionAuth.setAccountOrder` reorders them, and start, logout, and
health-test inputs accept an `accountId` or `addAccount`.

### Legacy Grok CLI probe

`checkGrokProviderStatus` is retained for legacy probe tests and is not used by `GrokDriver`.
It never opens an ACP session. It runs `grok --version`, then `grok models`
for login state and model slugs, then a single ACP `initialize` and reads models from
`_meta.modelState`. `authenticate` and `session/new` are skipped on purpose: `authenticate` can open
a browser login and `session/new` boots every configured MCP server, both of which made background
probes hang or surprise the user. A failed `initialize` degrades to `warning` with the CLI's model
list instead of persisting `error` over a working install. `XAI_API_KEY` counts as authenticated.
The built-in `grok-build` slug is the CLI's product name, not an ACP model id.
`applyGrokAcpModelSelection` treats it as "keep the session's current model" and never sends it in
`session/set_model`. Grok snapshots no longer advertise `requiresNewThreadForModelChange`, so an
in-session model change reaches ACP `session/set_model`.

OpenCode starts sessions through `AcpSessionRuntime.start()`. The new
`initialize()` method is additive and unused by that adapter.

ACP outbound notifications (`session/cancel` included) encode as JSON-RPC with no `id` or
`headers`. The previous Request encoder emitted `id: ""`, which Grok CLI treats as a malformed
request and drops, so Stop did not stop. `AcpSessionRuntime.cancel` now waits for the cancel
write before returning so a replacement prompt cannot race ahead of it. Grok mid-turn sends cancel
the in-flight prompt and continue the same turn instead of queueing.

Grok skill discovery uses `grok inspect --json` only for optional workspace catalogs.
`ProviderInstance.snapshotForCwd` recovers missing binaries and failed inspect requests to an empty
skill list. Machine snapshots do not probe the CLI.

`ServerProviderSkill` carries an optional `icon` (an emoji or a short glyph name from skill
frontmatter or provider metadata, e.g. the Codex app-server's interface icon paths). Clients
fall back to a source-kind glyph when a skill has no icon, so older servers that omit the
field decode fine. Driver coverage: Codex maps `interface.iconSmall ?? iconLarge`, Claude
reads an `icon` key from SKILL.md frontmatter, Grok forwards `icon` from `grok inspect`,
OpenCode's `/skill` endpoint reports no icon field, and Kimi For Coding has no skill-loading
mechanism so its catalog is intentionally empty.

Clients draw only text icons: `resolveProviderSkillTextIcon` in `packages/client-runtime`
accepts exactly one grapheme that is an emoji or pictographic symbol (keycaps, flags, ZWJ
sequences and variation selectors included) and rejects names, paths, multi-glyph text, and
control, bidi or stray zero-width characters. Claude's
emoji icons render. Codex icon paths point at the environment's disk, which a remote client
cannot load, and Grok's named glyphs are open vocabulary, so both fall back to the source-kind
glyph. The composer skill chip stores the resolved emoji on its Lexical node and still
serializes to `$name`.

## Temporary workers

Task, CheckSubagent, MessageSubagent, and StopSubagent let a bot hand a bounded subtask to a
short-lived worker during its own turn. They are separate from bot-to-bot delegation through
SendToAgent: a worker has no bot identity of its own and belongs to the parent turn that started it.
The contracts live in [`akeruWorkers.ts`][workers-contract] and the runtime in
[`AkeruWorkerRuntime.ts`][workers-runtime].

Task creates a child thread for the calling bot, with the parent's project, model, runtime mode, and
workspace, and starts a turn with the task text. The child is always a direct thread with the
responding bot, even when the parent is a group chat, so no group sender rules apply to it. If its
first turn cannot start, the child thread is deleted and the worker fails with `internal`. It waits for the result unless `background` is set.
CheckSubagent reports the current status, or waits for a terminal one. MessageSubagent starts a
follow-up turn on a running worker; the worker completes after its last open turn finishes.
StopSubagent interrupts the child turn. Every tool returns the same status with a tagged phase:
`Running`, `Completed`, `Failed` (`timeout`, `worker_failed`, or `internal`), or `Canceled`
(`stop` or `parent-turn-ended`). Terminal phases are final, so a late child result cannot revive a
stopped worker.

Limits are enforced by the runtime and returned as failed tool receipts with a readable message:

- Depth is at most 1. Task is hidden from workers, and a spawn from a worker fails with
  `depth_limit`.
- A parent turn may own at most 3 running workers. The fourth spawn fails with `concurrency_limit`
  until one finishes or stops.
- A worker without a result after 10 minutes fails with `timeout` and its child turn is
  interrupted.

When the parent turn finishes, fails, or is interrupted, every worker it still owns lands
`Canceled` with `parent-turn-ended` and its child turn is interrupted. Background workers do not
outlive the turn. A worker id only resolves from the chat that started it.

`workerAccess` in [`AkeruWorkerRuntime.ts`][workers-runtime] narrows the parent's delegation
grant. Workers get no memory scopes, an approval ceiling of `none`, no access to the user's
computer, and the parent's sandbox or the local workspace. `AKERU_WORKER_EXCLUDED_TOOL_IDS` removes
the worker tools, the agent tools (CreateAgent, CheckAgent, MessageAgent, StopAgent, SendToAgent),
channel creation and updates, SendToUser, request_box_help, ReactToMessage, and UpdateBotProfile.
The `none` ceiling covers MCP and built-in tools: a call that would open an approval request is
declined at once with an error the worker can read, so a worker never waits on a prompt nobody can
see. The worker tools themselves need no approval because they only start work that runs under
this narrower grant.

Child threads carry a `parentThreadId`, so the clients hide them from bot chat lists the same way they
hide delegated work.

The tools exist only in Mastra tool sessions with worker orchestration configured, which covers
Codex, Claude, Grok, Kimi For Coding, and OpenCode Go. Standard OpenCode stays on the legacy bridge
(`usesMastraCode` in [`AgentController.ts`][controller]) and does not advertise them. This is deliberate: the legacy bridge has no Akeru tool session to route
worker calls through, so advertising the tools there would promise behavior the provider cannot run.

## Raw protocol observation

The [ACP protocol](../../packages/effect-acp/src/protocol.ts) and
[Codex app-server protocol](../../packages/effect-codex-app-server/src/protocol.ts) retain raw
observations only when configured before connection. Incoming Codex JSONL is framed from
per-chunk fragments so large messages are scanned once. `AcpClientOptions` and `AcpAgentOptions` expose
`rawNotificationBufferSize` for `raw.notifications`. `CodexAppServerClientOptions` exposes that option
and `rawRequestBufferSize` for `raw.requests`. Pass them to the package's `make` or layer constructor.

- `0`, the default, retains nothing and completes the raw stream immediately.
- A positive safe integer `N` keeps the newest `N` unread events in a sliding queue. Overflow drops
  the oldest observation, including when a reader starts late or falls behind.
- `"unbounded"` explicitly restores the legacy lossless FIFO within the connection scope. An absent
  or slow reader can then retain the whole session.

These are work-sharing streams, not broadcasts. Enabled streams drain when input ends; closing the
connection scope discards the buffer and interrupts readers. Observation never blocks callback
dispatch. Notification callbacks, request handlers, and replies keep their existing behavior even
when raw observation is disabled or drops events. Reading `raw.requests` does not send a reply.
Use handlers for required protocol work, not a lossy observation stream.

This bounds optional transport observations, not provider transcripts or the Mastra Codex/Kimi turn
path described above.

## Composio runtime

Composio is an integration provider. Its toolkits appear as named plugins such as Gmail, but Akeru
does not create one durable MCP server for every toolkit. `ComposioService` stores the user-provided
API key in `ServerSecretStore` and creates one transient Composio MCP session for each Akeru thread.

The session includes only toolkits with active connected accounts. It enables Composio's search and
connection tools, so providers discover tool schemas when they need them. Multi-account mode requires
an explicit account choice when a toolkit has more than one account.

The MCP session URL and `x-api-key` header never enter orchestration events or MCP registry records.
`McpServerConfig` keeps headers in a runtime-only sidecar and adds them at each provider adapter
boundary. A change to the connected-account set invalidates the thread cache. The next turn gets a new
session URL and restarts the provider session through the existing MCP configuration check.

Akeru's approval middleware still controls tool execution. Composio handles hosted account sign-in,
but it does not replace Akeru's approval rules for send, delete, account-wide, or unknown mutating
actions.

`BotEngine.provider` stores the selected provider instance ID. AgentController keeps that instance
when it creates a runtime session, so selecting a model keeps the subscription and custom instance
that supplied it. Runtime ingestion reads the merged Mastra and adapter event stream once.

## Model routing

A bot's saved model is `BotEngine.model` in [contracts](../../packages/contracts/src/orchestration.ts).
On `thread.turn.start` the decider rewrites the command's `modelSelection` from the responding bot's
engine, so the controller — not the composer selection — decides what model the turn runs on. For
Mastra drivers (Codex, Claude, Grok, Kimi, OpenCode Go) `AgentController.resolveEngine` maps the
slug to the driver's wire format (`openai/<model>`, `anthropic/<model>`, `xai/<model>`,
`kimi-for-coding/<model>`, `opencode-go/<model>`) and calls `session.model.switch` on the live
session, so a mid-chat model change does not rebuild the session. Standard OpenCode runs through the
legacy adapter bridge and re-sends `modelSelection` on each turn.

Model validation fails closed at three layers, and all three only honor the model catalog once
the provider snapshot reports `status === "ready"`. Pending and fallback snapshots still carry the
built-in catalog, so an unlisted model there is not evidence the model is gone:

- `bot.create`/`bot.update` reject an engine whose model is absent from a settled provider
  snapshot's model list. Custom model slugs configured in settings are already merged into that
  list.
- `thread.turn.start` preflights both the command selection and the responding bot's saved engine
  against the same settled snapshot; an unadvertised model returns a typed `unsupported-model`
  dispatch error before `turn.started` is emitted. For group threads without an explicit
  `respondingBotId` the bot-engine check is skipped there, because the decider may pick a different
  responder than the thread's last one; `inspectEngine` still covers the real responder.
- `AgentController.inspectEngine`/`resolveEngine` re-check the saved model against the instance's
  settled snapshot before dispatch, which also covers channels and delegations that never pass
  through the WebSocket layer. An absent, unsettled, or empty catalog is treated as unknown, not
  as proof the model is wrong.

When a provider reroutes a request to a different model at runtime and reports it, adapters emit
the `model.rerouted` runtime event and `ProviderRuntimeIngestion` projects it as a
`model.rerouted` chat activity line (`Model rerouted from X to Y`), so the effective model is
visible rather than a silent fallback. Today only the legacy Codex adapter emits this event;
Mastra sessions do not report the effective model yet, so a reroute inside a Mastra driver never
produces the activity.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## Model catalog

Model lists, display names, and the picker's legacy section come from
[models.dev](https://models.dev). `modelCatalogData.ts` maps each driver to a models.dev provider
(`codex` to `openai`, `claudeAgent` to `anthropic`, `grok` to `xai`, `kimi` to
`kimi-code-plan-global`, `opencodeGo` to `opencode-go`) and keeps only models a coding agent can
run: tool calling, text output, no dated Claude snapshots, and for Codex only GPT reasoning models
outside the Pro and nano tiers. For Codex, Claude, and Grok, a model is current when it is the
newest non-deprecated model in its family and was released within 180 days of the provider's
newest model. Kimi For Coding and OpenCode Go list every non-deprecated model as current.

The `ModelCatalog` service (`ModelCatalog.ts`) runs its own loop that refetches models.dev
hourly, retries a failed fetch after five minutes, and respects `enableProviderUpdateChecks`.
Preference order is the last fetch, then its on-disk copy (`model-catalog.json` in the state
directory), then the bundled `apps/server/src/provider/model-catalog.json`. A fetch that omits a
driver keeps that driver's previous models, and a fetch never fails a provider check. When the bundle
lists a driver release newer than anything in the on-disk copy, that driver uses the bundled list
until the next fetch, so upgrading while offline still shows a newer release's models. Drivers apply the catalog to every snapshot. Codex, Claude, and
Grok publish it on their periodic health check; Kimi For Coding and OpenCode Go have no periodic
check, so they republish when the catalog's `changes` stream emits. Kimi For Coding
and OpenCode Go keep a hardcoded fallback list whose first slug stays the default, and Grok keeps
`grok-build` current because models.dev does not list it.

Regenerate the bundle with `node apps/server/scripts/sync-model-catalog.ts` (pass a saved
`api.json` path to work offline). `model-manifest.json` is the older current-model list that
released builds before the catalog still fetch from `main`; keep its current IDs in step with the
catalog until those builds age out.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[kimi]: ../../apps/server/src/provider/Drivers/KimiDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[opencode-go]: ../../apps/server/src/provider/Drivers/OpenCodeGoDriver.ts
[custom-openai]: ../../apps/server/src/provider/Drivers/CustomOpenaiDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[controller]: ../../apps/server/src/provider/Layers/AgentController.ts
[seam]: ../../apps/server/src/provider/AkeruRuntimeSeam.ts
[bridge]: ../../apps/server/src/provider/Layers/LegacyProviderBridge.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[workers-contract]: ../../packages/contracts/src/akeruWorkers.ts
[workers-runtime]: ../../apps/server/src/provider/AkeruWorkerRuntime.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
