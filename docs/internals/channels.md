# External channels

External channels connect a messaging conversation to normal Akeru orchestration. A channel adapter never calls a provider agent directly.

## Durable model

A reusable connection profile contains safe display data. Credentials live in the environment secret store. A bot binding selects the provider, connection, and project.

An external conversation maps to a deterministic Akeru thread using the bot, project, provider, and provider conversation identity. A provider message identity derives the turn command and message identities. The orchestration command receipt makes repeated delivery idempotent across process restarts.

The Akeru thread is the conversation. A turn is one unit of work. There is no channel session model or separate external inbox.

## Runtime boundary

`ChannelRuntime` owns provider transports and normalizes inbound messages to:

- provider;
- connection and selected project;
- external conversation identity;
- external message identity;
- sender identity and display name;
- supported text content.

The runtime dispatches `thread.create` when the deterministic thread does not exist, then dispatches `thread.turn.start`. Provider selection, tools, memory, permission mode, usage limits, delegation, checkpoints, and projections follow the normal Akeru path.

After a channel-originated turn completes, provider runtime ingestion resolves the final owner reply and queues external delivery. `ChannelDeliveryStore` claims delivery before provider I/O. Bot binding recovery metadata stays bounded and does not replace the delivery store.

## Delivery recovery

The delivery store retains an unfinished claim when provider acceptance is unknown. Akeru does not retry that post automatically, including after reconnect. A fixed binding warning exposes the unresolved state without exposing provider error details. Confirmed message IDs in the binding are limited to 128; the delivery store remains authoritative after an ID leaves that list.

The shipped Slack, Discord, and Telegram post wrappers recognize specific structured rejection errors. Only a rejection that proves no text was accepted releases a claim for retry. Slack SDK request retries are disabled so an earlier accepted attempt cannot be hidden by a later rejection.

WhatsApp can fail after accepting an earlier text chunk, and its adapter does not retain enough structured error data to prove rejection. Photon has internal retries that Akeru cannot classify as unaccepted. These adapters keep all post errors ambiguous. This is not an exactly-once delivery guarantee.

## Conversation policy

Telegram, iMessage, and WhatsApp accept direct messages only. Slack and Discord accept direct messages and direct bot mentions in platform threads. After the first Slack or Discord mention, the adapter subscribes to that platform thread. Later replies continue the same Akeru thread.

External senders do not become paired people or in-app group members. The assigned bot remains the only external reply owner. It can use normal Akeru delegation, but child bots and provider subagents do not post to the external channel.

## Quiet status signals

Slack and Discord request messages carry one status reaction: accepted (`eyes`), completed (`white_check_mark`), or failed/cancelled (`x`). `updateChannelStatus` serializes updates per transport, removes previous status reactions before setting the next one, and bounds per-transport tracked statuses. Provider runtime ingestion enqueues terminal updates from `turn.completed`, `turn.aborted`, `session.exited`, and error/stopped session states through a drainable worker. Disconnect, reconnect, and restore clear persisted reactions from channel-origin messages. Providers without reaction support emit no signal.

## Capabilities

The shared provider capability record states whether an adapter supports direct messages, mentions, threads, reactions, typing state, message edits, attachments, and interactive actions. Runtime and client behavior must follow this record instead of assuming every provider has the same features.

## Lifecycle

A channel supports save, assign, connect, reconnect, disconnect, unassign, and delete. Server startup restores connected transports. A failed restore produces a visible repair state and does not stop server startup.

Slack uses Socket Mode. Discord and Photon use supervised Gateway listeners that renew after their finite listener period expires. An early listener exit marks the transport unhealthy. Shutdown waits for listener cleanup. Retired transport callbacks cannot start new work after disconnect or replacement.

Startup restores Slack and Discord subscriptions from channel origins in full thread records. Slack subscriptions exist before Socket Mode starts. First-mention context includes at most ten earlier messages and 8,000 characters. The current mention remains intact.

Replies must match the current binding's project. Reassigning a channel to another project prevents old-project replies from using the new assignment.

## Security boundary

The server requires the environment administrator scope, `access:write`, for every credential and assignment command. UI checks are presentation only. Secrets must not enter settings responses, orchestration events, logs, analytics, diagnostics, URLs, or client state.

`channel.attach` requires a project ID for new assignments. The shared `defaultProjectIdForBot` helper remains available to clients as a preselection hint only; the server validates the submitted project and never silently falls back. Legacy bindings without a project remain readable, are flagged as needing confirmation, and must be assigned a live project before reconnecting. Direct `channel.connect` requests still require an explicit project ID.

The resolved project is persisted on the binding. Inbound work uses that assignment instead of resolving a new default for each message. If the assigned project becomes unavailable, the channel blocks and reports a repair state.

### Runtime lifetime

`ChannelRuntime` in `apps/server/src/channels/ChannelRuntime.ts` is an Effect service, and all channel state lives in the instance its layer builds. There is no module-level runtime, fallback state, or saved dependency set. The server layer graph provides `ChannelRuntime.layer`, which resolves the orchestration engine, projection snapshot query, settings, secret store, and delivery store from context. It builds nothing when the secret store or delivery store is absent, so consumers read it with `Effect.serviceOption`. Tests build `ChannelRuntime.layerWith(dependencies)` with their own dependencies, and each built layer is isolated from the others.

WebSocket commands, the HTTP bot routes, the WhatsApp webhook route, startup restore, and provider runtime ingestion resolve the service from context and compose its Effects. Dependency Effects run in the caller's fiber and context. The only place code crosses from Promise callbacks into Effect is SDK callbacks such as inbound messages and webhooks. Those run through a `FiberSet` runtime captured from the service scope, so closing the scope interrupts callback work that is still running.

Running transports live in the runtime's transport map, and the service scope has one finalizer that shuts down every transport in that map. Built-in transports also acquire their own resources, such as a renewing gateway, in a child of the service scope, so closing it stops those listeners too. `shutdown` checks the running transports each time it runs, so it also stops transports that started after the service was built. Operations, failures, and errors are typed: transport I/O fails with `ChannelTransportError`, a definite provider rejection with `ChannelPostRejectedError`, and runtime policy failures with `ChannelRuntimeError`. Injected transports that throw `ChannelPostRejectedError` keep that type.

Gateway renewal is a scoped Effect `Schedule`. `startRenewingGateway` launches the first listener before it returns, and fails if that launch fails, so the channel is never saved as connected without a listener. It then watches each listener for `CHANNEL_GATEWAY_RENEWAL_INTERVAL` (one hour) and relaunches at the deadline. Each relaunch aborts and awaits the previous listener first, so two listeners never run at once. A listener that exits early or fails to relaunch leaves the gateway unhealthy and stops renewal. Shutdown closes the renewal scope, aborts the listener, and waits for the listener task. Tests drive renewal with `TestClock`.

Per-provider channel work, per-connection operations, connection settings, and per-bot binding updates are serialized by `makeKeyedLock`. It is a FIFO lock per key that releases the key after completion or interruption. An interrupted caller that is still waiting leaves the queue without blocking the callers behind it.

### Explicit project bindings

Every new `channel.attach` command names a live project explicitly. The server validates that the project is live before starting the provider runtime, so channel turns cannot silently move between workspaces. Existing bindings without a project remain readable and are shown as needing confirmation; operators can use `channel.change-project` to select a replacement. If a selected project is deleted or unavailable, the binding becomes `blocked` with the repair message “Choose another project” and inbound replies remain blocked until reassigned.

`channel.change-project` validates the target project, the binding, saved credentials, and identity availability before it stops the running runtime. If the new project fails to start, the server restarts the previous project when that binding was connected. If neither starts, the binding stays on its previous project with a failed or blocked status, so it is never half-switched. Clients share the picker rules in `@t3tools/client-runtime/channel-presentation`: `channelBindingNeedsProject`, `channelPickerProjectId` (explicit choice, then the running project, then the `defaultProjectIdForBot` hint), and `canChangeChannelProject`. Web Settings, the bot Channels sheet, and the mobile chat Channels section all repair through `botEnvironment.channels.changeProject`.
