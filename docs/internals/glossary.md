# Glossary

> For maintainers. Using Akeru Bot? See [docs/user](../user/).

This is a living glossary for Akeru Bot. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Roster organization](#roster-organization)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Subscription provider](#subscription-provider)
- [Image provider](#image-provider)
- [Interface language](#interface-language)
- [Checkpointing](#checkpointing)
- [Dictation](#dictation)
- [Stored-reply playback](#stored-reply-playback)

## Concepts

### Project and workspace

#### Project

The top-level workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot` and a title. It does not contain threads: `OrchestrationProject` and `OrchestrationThread` are separate arrays on the read model, and a project can have zero threads. See [workspace-layout.md][2].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live behind the VCS driver contract in `apps/server/src/vcs/VcsDriver.ts`, implemented by [GitVcsDriverCore.ts][3].

### Thread timeline

#### Thread

The internal durable record for one user-facing chat and its workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. Interface copy and user documentation call this a chat or conversation. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when the session leaves `running` status, which [projector.ts][4] treats as the authoritative completion signal (`settledTurnStateForSessionStatus`). Checkpoint and diff work may settle afterward without changing when the turn ended. See [the contracts][1] and [ProviderRuntimeIngestion.ts][5].

#### Silent run

A running turn whose provider has sent no output for `SILENCE_WATCHDOG_SILENT_MS` (90 seconds). Ingestion records it as a `turn.silent` activity and clears it with `turn.silent.cleared` or the end of the turn. It is a status, not a failure: nothing interrupts the turn. See [silence-watchdog.md](./silence-watchdog.md).

#### Temporary worker

A short-lived helper a bot starts with the Task tool during its own turn. It runs in a hidden child thread under a narrower grant, cannot start workers of its own, and is canceled when the parent turn ends. It is not a bot and is separate from bot-to-bot delegation. See [providers.md](./providers.md#temporary-workers).

### Roster organization

The live sidebar is `BotRosterSidebar`. Pins and the main Bots list are a client layout over bots and groups. They must not assign or remove group members, and they must not settle chats. Drag planning lives in `roster.logic.ts`; pointer cleanup, insertion-gap projection, and list motion live beside it in `roster.pointer.ts`, `roster.drag.ts`, and `roster.motion.ts`.

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

#### Bot memory

Small, server-owned Markdown context attached to one named bot: `USER.md`, `MEMORY.md`, and one
bot-specific `GROUP.md` per group. It is distinct from bot instructions and thread observational
memory. See [memory architecture](memory.md).

#### Memory approval

A pending request from a bot to save a shared durable fact at project, group, or workspace scope.
It appears as a chat card and a bot inbox item, and either one decides it through
`candidate.decide`. See [shared memory approvals](memory.md#shared-memory-approvals).

#### Observational memory

An automatically generated, inspectable summary of older content in one thread. It complements the
recent complete-turn window and never acts as a writable group-wide memory store. See
[memory architecture](memory.md).

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is usually `project` or `thread`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Receipt

A typed signal emitted when an async milestone completes, such as `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, or `turn.processing.quiesced`. Receipts are a test-only mechanism: the production `RuntimeReceiptBusLive` publish is a no-op and only the test layer is PubSub-backed. Do not build production behavior on them. See [RuntimeReceiptBus.ts][13] and [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable: follow-up work such as [CheckpointReactor.ts][6] has settled. It appears in [the receipt schema][13], so in practice it is something tests wait on rather than a production signal.

#### Delegation

Work one bot sends to another with `SendToAgent`. It runs in a child thread and returns a handle at once. Its finished result is acknowledged exactly once, when the parent's next turn starts or when `CheckAgent` reads it. See [delegation.md](delegation.md).

#### Waiting on children

A thread with queued, running, or blocked delegations. Derived by `isThreadWaitingOnChildren`, never persisted.

### Dictation

Hold-to-talk capture on the active client that transcribes into the current composer draft. The
session, identity binding, and draft merging live in `packages/client-runtime/src/dictation`, which
also binds transcription to the environment's `voice.transcribe` RPC. Browser capture lives in
`apps/web/src/lib/dictationCapture.ts` and native capture in
`apps/mobile/src/lib/expoDictationCapture.ts`. A transcript is applied only while the environment,
thread, draft, and draft generation still match the ones captured at start.

### Computer viewer

The client window that shows a bot's Daytona computer and hands input control between the bot and one
person. The state machine and the controller that serializes RPC calls live in
`packages/client-runtime/src/state/computerViewer.ts` and `computerViewerController.ts`. The web
client renders it; mobile only points to desktop or web. See
[computer-control.md](./computer-control.md#client-lifecycle).

### Stored-reply playback

Reading an existing assistant message on the current client speaker. Identity, spoken-text conversion, playback ownership, and the client-local automatic-readout preference live in `packages/client-runtime/src/replyPlayback`. Synthesis credentials and the speech operation belong to the live-call voice work, not this module. See [reply-playback.md](./reply-playback.md).

### Subscription provider

A consumer AI account that a user connects through OAuth, such as ChatGPT, Claude, Grok, or Kimi For Coding. OpenCode Go uses an API key instead of OAuth. The environment server stores the credential and gives a run only the access token it needs. See [subscription authentication](./subscription-auth.md).

### Image provider

The subscription that creates images for a bot, ChatGPT or Grok, chosen per bot or by the global default and independent of the bot's chat provider. Bots reach it through the `generate_image` tool, and each finished image is saved as an ordinary chat attachment. See [image-generation.md](./image-generation.md).

### Interface language

A client-local preference for interface copy. Web, Electron, and native mobile each store their own selection. It never rewrites stored messages, bot names, instructions, paths, or protocol identifiers. See [interface-translations.md](./interface-translations.md) and [app language](../user/language.md).

## Provider runtime

The live backend agent implementation and its event stream. Desktop turns cross [AgentController][25]. Codex, Claude, Grok, Kimi, and OpenCode Go use Akeru's Mastra Core controller, custom workspace and MCP tools, exact-instance server-owned access, and normalized Mastra runtime events. Standard OpenCode remains the explicit compatibility runtime because its API exposes an OpenCode-owned agent session rather than a raw model transport. The adapter contract is [ProviderAdapter.ts][15], and the overview is in [providers.md][16].

#### Provider

The backend agent runtime that actually performs work. Six drivers ship built in: Codex, Claude, Grok, Kimi For Coding, OpenCode, and OpenCode Go. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17] as a representative adapter.

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. [The contracts][1] define four values: `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. See [permission modes][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the values are `default` and `plan`.

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` accumulates text. Buffered delivery is not held until the turn completes: it spills once accumulated text would exceed 24,000 characters, and flushes at approval and user-input boundaries. See [ProviderRuntimeIngestion.ts][5].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

#### Model routing

The path a bot's saved model takes to its provider. On `thread.turn.start` the decider rewrites the
command's `modelSelection` from the responding bot's engine, Mastra drivers map the slug to a wire
id such as `openai/<model>` or `anthropic/<model>` and call `session.model.switch`, and standard
OpenCode re-sends `modelSelection` per turn through the legacy bridge. Validation fails closed at
`bot.create`/`bot.update`, at turn-start preflight in `ws.ts`, and at `AgentController.inspectEngine`,
and all three only trust a provider snapshot that reports `status === "ready"`. See
[providers.md](./providers.md#model-routing) and
[provider-model-routing.md](../operations/provider-model-routing.md).

#### Model reroute

A runtime report that the provider served a different model than the one requested. Adapters emit
the `model.rerouted` runtime event and ingestion projects a `model.rerouted` activity line so the
change is visible. Today only the Codex adapter emits it. See
[providers.md](./providers.md#model-routing).

#### Model manifest

The per-driver list of current model slugs that decides which models land in the model picker's legacy section. Bundled at `apps/server/src/provider/model-manifest.json` and refreshed at runtime from the same file on `main`, so classification updates ship as commits instead of releases. See the [provider architecture][16] model manifest section.

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The difference between two checkpoints. On-demand diffs stay as patches; automatic turn summaries use NUL-delimited Git numstat. Query logic lives in [CheckpointDiffQuery.ts][20], summary parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal, for tests".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Permission modes][18]
- [Workspace layout][2]

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[25]: ../../apps/server/src/provider/Services/AgentController.ts
