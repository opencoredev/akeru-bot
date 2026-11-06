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

`sendChannelMessage` mirrors each delivery transition onto the assistant message as `channelDelivery` (`pending`, `sent`, `failed`, `unknown`) through the internal `thread.channel-delivery.set` command. On startup, restore reconciliation marks each still-`requested` claim `unknown` when its projected state is `pending` or missing, and a post that lands before its mark-sent write fails records `sent` before the original error propagates. The projector and `projection_thread_messages.channel_delivery` column both carry the state, and the snapshot query left-joins `channel_deliveries` so older databases that lack the projected field still read `requested` as `pending` and `sent` as `sent`. Web and mobile render the state under each channel-originated reply via `channelDeliveryLabel` in `channelOriginPresentation.ts`.

External replies gain an "Open in Akeru" footer only when the operator sets an explicit public origin (`--public-origin` or `T3CODE_PUBLIC_ORIGIN`). A `--host` bind address is never used: publishing a LAN or tailnet bind into a third-party chat would leak an address that is dead or private outside that network. The value is never read from browser origins or request headers. The link targets `/bots/<botId>` on that origin.

The shipped Slack, Discord, and Telegram post wrappers recognize specific structured rejection errors. Only a rejection that proves no text was accepted releases a claim for retry. Slack SDK request retries are disabled so an earlier accepted attempt cannot be hidden by a later rejection.

WhatsApp can fail after accepting an earlier text chunk, and its adapter does not retain enough structured error data to prove rejection. Photon has internal retries that Akeru cannot classify as unaccepted. These adapters keep all post errors ambiguous. This is not an exactly-once delivery guarantee.

## Conversation policy

Telegram, iMessage, and WhatsApp accept direct messages only. Slack and Discord accept direct messages and direct bot mentions in platform threads. Discord passes empty `mentionRoleIds` and `respondToChannelIds` and disables global mentions, so ambient `DISCORD_*` environment variables cannot widen the policy. A first Discord mention outside a thread creates a platform thread on that message. Slack connect probes the app-level token with `apps.connections.open` before saving the binding. Only a Slack auth error (`invalid_auth`, `not_authed`, `token_revoked`, and similar) fails with the `credentials` category. Network failures, HTTP error pages, and other Slack errors fail with "Slack could not be reached" and the `network` category. After the first Slack or Discord mention, the adapter subscribes to that platform thread. Later replies continue the same Akeru thread.

External senders do not become paired people or in-app group members. The assigned bot remains the only external reply owner. It can use normal Akeru delegation, but child bots and provider subagents do not post to the external channel. Finished delegated work reaches the channel only through the assigned bot's next turn. Akeru starts no follow-up turn when the work finishes, so the external sender sees the result in the reply to their next message. Channel turns receive those results as plain text; see [Channel turns](delegation.md#channel-turns).

## Quiet status signals

Slack and Discord request messages carry one status reaction: accepted (`eyes`), waiting on an approval or user-input answer (`hourglass`), completed (`check`, which Slack renders as `white_check_mark`), or failed/cancelled (`x`). Ingestion tracks open requests per provider turn and swaps `eyes` for `hourglass` while any are open, then back once they resolve. `updateChannelStatus` serializes updates per transport, removes previous status reactions before setting the next one, and bounds per-transport tracked statuses. Provider runtime ingestion enqueues terminal updates from `turn.completed`, `turn.aborted`, `session.exited`, and error/stopped session states through a drainable worker. Disconnect, reconnect, and restore clear persisted reactions from channel-origin messages. Providers without reaction support emit no signal.

## Capabilities

The shared provider capability record states whether an adapter supports direct messages, mentions, threads, reactions, typing state, message edits, attachments, and interactive actions. Runtime and client behavior must follow this record instead of assuming every provider has the same features.

## Lifecycle

A channel supports save, assign, connect, reconnect, disconnect, unassign, and delete. Server startup restores connected transports. A failed restore produces a visible repair state and does not stop server startup.

Slack uses Socket Mode. Discord and Photon use supervised Gateway listeners that renew after their finite listener period expires. A first listener launch that fails fails the connect with its own category: a thrown network error or a 5xx or 429 status is `network`, and any other status is `credentials`. A later early exit marks the transport unhealthy. Shutdown waits for listener cleanup. Retired transport callbacks cannot start new work after disconnect or replacement.

Startup restores Slack and Discord subscriptions from channel origins in full thread records. Slack subscriptions exist before Socket Mode starts. First-mention context includes at most ten earlier messages and 8,000 characters. The current mention remains intact.

Replies must match the current binding's project. Reassigning a channel to another project prevents old-project replies from using the new assignment.

## Health

A `ChannelBinding` reports health through `status`, `lastError`, `failureCategory`, and `lastSucceededAt`:

- `connecting` is written before a transport starts and replaced by `connected` or a failure. The server tracks starts in flight, so `channelBindingsForRuntime` reads a `connecting` binding with no start in flight, left by a crash mid-connect, as `needs-reconnect`. It does the same for a `connected` binding whose transport is not running.
- `failureCategory` is one of `credentials`, `network`, `project`, `delivery-unknown`, or `restore`. It is present only with `lastError`. A successful connect clears both. A delivered reply clears both unless another reply's delivery is still unknown.
- A `connected` binding can carry `lastError`. When a reconnect, attach, or new token fails while the old transport keeps running, the binding stays `connected` and records the failure, so the channel keeps working and the client still offers a repair.
- `lastSucceededAt` records the most recent successful connect or confirmed delivery. Later failures keep it, so clients can show when the channel last worked.

`watchTransportExit` persists `needs-reconnect` with the `network` category when a transport that exposes `settled` stops on its own. Today that is the Discord and Photon gateway listeners. The `bot.update` it dispatches pushes the change to every subscribed client, so a dead channel stops reading as connected without a refresh. A disconnect or replacement retires the transport first, so its exit writes nothing. Telegram, Slack, and WhatsApp transports do not report an exit; their health changes only through commands, restore, and the read-time check above.

`channelRepairAction` in `@akeru/client-runtime/channel-presentation` maps status plus category to one repair: wait, connect, reconnect, update credentials, choose a project, check delivery, or set a public URL. For a `connected` binding it offers update credentials for `credentials`, reconnect for `network` or `restore`, and check delivery for `delivery-unknown`. Clients should render that action instead of interpreting `lastError`.

Web renders health through `apps/web/src/components/settings/ChannelStatus.tsx`, shared by Settings > Bot channels and the bot Channels sheet. `ChannelStatusBadge` names the state, `ChannelStatusNotice` shows the fixed `lastError` text or the WhatsApp public URL explanation, and `ChannelRepairButton` renders the one action from `channelRepairAction`. Check delivery links to the connection's `managementUrl`, so the card hides its separate provider link for that action. Setting a public URL has no button because the client cannot fix it. The notice shows the webhook URL only when the connection profile carries a server-built `webhookUrl`; the web reads that field optionally and never derives it from the browser origin, which may be a private address.

Update credentials in Settings saves the new credentials as a new connection, detaches the old one, and attaches the new one to the same bot and project. The old profile is deleted only after the attach succeeds. If the attach fails, the dialog reattaches the old connection and deletes the new profile. The bot Channels sheet sends this action to Settings because it has no credential form. Mobile stays status-only and points to Settings on the host.

`isChannelIdentityConflict` in `apps/web/src/channelAccess.ts` recognizes the server's two fixed identity conflict messages in a command failure cause by exact match, so clients can show plain conflict copy without parsing other errors.

A failed connect or attach rolls back what it started. The transport stops, a `connecting` binding for a new assignment is removed, and a previously saved credential stays saved. If the bot is archived or deleted while its channel connects, the start is refused at commit, the transport stops, and the `connecting` binding is removed or put back as it was, so restore never starts it. When another bot already uses the same external identity, the command fails before it replaces the live transport.

### Error text

Provider SDK errors can echo tokens, request bodies, or account details. `ChannelTransportError` carries the fixed message "Channel provider request failed." and keeps the SDK rejection only as its cause for classification. `channelFailurePresentation` turns any failure into a fixed message for its category, and `ChannelCommand.channelCommandFailure` applies it at the command boundary. The WebSocket route returns that message. The HTTP route returns the `orchestration_dispatch_failed` reason and logs only the category. A `channel.send` that fails with a network or credentials error reports `delivery-unknown`, because the provider may already have accepted the post. A definite provider rejection (`ChannelPostRejectedError`) keeps its own category, `credentials` unless the transport names another, on the binding and in the command failure. Startup restore logs the bot, provider, and category of each failure, never an error or cause.

### Reply ownership

`resolveCompletedChannelReply` sends a reply only for the owning bot's own turn. A delegated child thread, a turn another bot answered, and a provider subagent resolve to no reply, and each drop is logged at trace level. The decider rejects a turn that would give a delegated child thread a channel origin, so a channel message always lands in the owning bot's thread. Inbound handlers ignore messages with neither text nor files, and messages written by any bot, including this one, so two connected bots cannot answer each other in a loop. Discord, Slack, WhatsApp, and iMessage always mark a person's message with `isBot: false`, so an `"unknown"` author there counts as a bot. Telegram reports `"unknown"` for messages sent on behalf of a chat, such as anonymous group admins and linked channel posts, so Telegram ignores only an explicit `true`.

### Inbound content

`normalizedInboundMessage` in `apps/server/src/channels/ChannelInbound.ts` is the boundary parse for every provider's inbound message, Telegram included.

Slack's adapter builds `message.text` as the plain-text rendering of `message.formatted`, and that rendering keeps only a link's label. When `message.text` equals `toPlainText(message.formatted)`, `plainTextWithLinks` walks the tree and renders each link as `label (url)`. A label that matches the URL or the URL without its scheme stays as written, ignoring one trailing slash on either side. An empty label becomes the URL. When no target was added, the adapter's original `message.text` is kept. Discord's `parseDiscordMessage`, which builds the messages in `recentMessages`, flattens text the same way, so Discord mention context lines also get `label (url)`. Telegram, WhatsApp, iMessage, and Discord's live gateway messages, including the content of a forwarded message, pass raw markdown through as `message.text`. Each link there already reads `[label](url)`, so that text reaches the bot unchanged. Rendering the markdown to plain text would drop code fences, list numbers, and emphasis markers.

The same parse maps `message.attachments` to `InboundChannelAttachment` values. Each has a name capped at 255 code points, the platform MIME type when the platform sends one, the declared size, the URL, and a lazy `fetch` when the adapter provides `fetchData`. The name, MIME type, and URL are each collapsed to one line, because any of them can appear in a note line. Nothing downloads at parse time.

`mentionWithContext` reads context only from messages before the mention. `recentMessages` is oldest first, so context ends at the mention's position in that list. When the list no longer holds the mention, only messages dated in an earlier millisecond are kept. Slack times messages in microseconds, so a later reply can share the mention's millisecond, and an earlier message in that millisecond is dropped rather than risk taking a later one.

A context message that shares files is kept even when its text is blank. Its context line ends with one marker per file, such as `U1: [shared shot.png]`. One walk from the newest context line to the oldest keeps lines while they fit `CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT`, and cuts only the oldest kept line from its start. The context text and the context files both come from that kept list. A context file comes along only while its own marker is intact, so the bot never gets a file the context text no longer names. The mention's attachments are its own files first, then the context files from newest to oldest, so the file limit prefers what the person mentioned. Context files carry `sharedInMentionContext`.

### Inbound files

Files move in two phases so a slow download never holds the provider lock. That lock, `channel:<provider>`, is shared by every bot on the provider with outbound replies, connects, and status reactions.

The inbound callback awaits both phases, so one SDK handler can run for a minute. Every `Chat` is built with `CHANNEL_CHAT_CONCURRENCY`, the SDK's `concurrent` strategy with `maxConcurrent: 1`. A second message in the same platform thread waits for the first handler, in arrival order, instead of being dropped with a `LockError` as the SDK's default `drop` strategy does. The SDK's `queue` strategy would keep only the newest waiting message. Different threads still run at once. The wait starts before the handler runs, so a reply that arrives while a mention subscribes and reads its thread stays behind that mention. The SDK dedupes a message before the wait and checks the thread's subscription after it, so a reply that waited behind a mention sees the subscription that mention made and reaches `onSubscribedMessage`.

`downloadInboundAttachments` in `ChannelInboundAttachments.ts` runs in the inbound callback before the lock. It applies the composer's rules. The MIME type must be a supported image or file type, matched without parameters such as `; charset=utf-8`. The per-type byte limit is checked on the declared size before download and on the real byte length after. Only files that pass the type and size rules and have a download count toward `PROVIDER_SEND_TURN_MAX_ATTACHMENTS`, in message order. A file whose download fails after it was selected keeps its slot. Every download takes a permit from `ChannelRuntimeContext.inboundDownloadPermits`, one semaphore of `INBOUND_DOWNLOAD_PERMITS` (four) shared by every bot and message. The SDK's `fetchData` buffers a whole file, so the size limit can only stop a download early when the platform declares a size. Slack, Discord, and Telegram do. WhatsApp does not, so a file with no declared size takes every permit and downloads alone. That keeps at most one file of unknown size in memory at a time. Each fetch has 30 seconds once it holds a permit. A download that times out counts as failed. The SHA-256 of each downloaded file is computed here, outside both locks, and travels on `DownloadedChannelFile`.

Inside the lock, `dispatchInboundChannelMessage` writes each downloaded file with `saveDownloadedFiles` and then dispatches `thread.turn.start`, so the write and the dispatch stay together. Each file goes through `writeAttachmentIfMissing` in `apps/server/src/attachmentStore.ts`. A channel file's id derives from its bytes, so a file already at that id holds the same bytes and is kept. Writing it again would rename over a file that may be open, and on Windows that rename fails with `EPERM`. A missing file goes through `writeFileAtomically`, the same step the dispatch normalizer's `writeAttachment` and inline uploads use. It writes a `.part` file beside the target and renames it over the target, so a turn never reads a partial file. The pending-attachment sweep removes `.part` files left by a crash.

A file of the message itself that is skipped, fails to download, or fails to save adds one note line such as `[Shared file "report.zip" was not attached: unsupported type application/zip]` to the turn text. A context file adds no note, because its `[shared name]` marker already names it. Download and write failures are logged at warning level with the file name and a category, `timeout`, `download`, or `save`, never the SDK error. They never fail the turn. A message with files and no text dispatches the notes, or an empty string when every file was attached.

Attachment ids come from `channelFileAttachmentId(threadId, messageId, sha256Hex, occurrence)`, built on `deterministicAttachmentId`. The key joins the message id, the SHA-256 of the file's bytes, and the file's occurrence among files with the same hash in the message. It leaves out the file's position, because context files can shift position when a mention is redelivered. The id is the thread's attachment segment followed by a UUID-shaped digest of the key. The message id is deterministic for a platform message id, so a redelivered message with the same files maps to the same ids. Files are saved before the turn is dispatched, and the engine answers a repeated turn command from its receipt. So when a message's turn was reverted, which prunes its files, a later redelivery of that message saves them again without a turn that references them. They stay until the thread is deleted. A redelivery also leaves a file behind when a context file changed or dropped out of the context. That file gets no turn, but its earlier copy stays until the thread is cleaned up. The thread segment keeps the ids inside that thread cleanup and lets the asset route serve them by id.

## Security boundary

The server requires the environment administrator scope, `access:write`, for every credential and assignment command. UI checks are presentation only. Secrets must not enter settings responses, orchestration events, logs, analytics, diagnostics, URLs, or client state.

`channel.attach` requires a project ID for new assignments. The shared `defaultProjectIdForBot` helper remains available to clients as a preselection hint only; the server validates the submitted project and never silently falls back. Legacy bindings without a project remain readable, are flagged as needing confirmation, and must be assigned a live project before reconnecting. Direct `channel.connect` requests still require an explicit project ID.

The resolved project is persisted on the binding. Inbound work uses that assignment instead of resolving a new default for each message. If the assigned project becomes unavailable, the channel blocks and reports a repair state.

### Runtime lifetime

`ChannelRuntime` in `apps/server/src/channels/ChannelRuntime.ts` is an Effect service, and all channel state lives in the instance its layer builds. There is no module-level runtime, fallback state, or saved dependency set. The server layer graph provides `ChannelRuntime.layer`, which resolves the orchestration engine, projection snapshot query, settings, secret store, delivery store, server config, file system, and path services from context. It needs the server config's `attachmentsDir` to save files shared in channel messages. It builds nothing when the secret store or delivery store is absent, so consumers read it with `Effect.serviceOption`. Tests build `ChannelRuntime.layerWith(dependencies)` with their own dependencies, and each built layer is isolated from the others.

WebSocket commands, the HTTP bot routes, the WhatsApp webhook route, startup restore, and provider runtime ingestion resolve the service from context and compose its Effects. Dependency Effects run in the caller's fiber and context. The only place code crosses from Promise callbacks into Effect is SDK callbacks such as inbound messages and webhooks. Those run through a `FiberSet` runtime captured from the service scope, so closing the scope interrupts callback work that is still running.

Running transports live in the runtime's transport map, and the service scope has one finalizer that shuts down every transport in that map. Built-in transports also acquire their own resources, such as a renewing gateway, in a child of the service scope, so closing it stops those listeners too. `shutdown` checks the running transports each time it runs, so it also stops transports that started after the service was built. Operations, failures, and errors are typed: transport I/O fails with `ChannelTransportError`, a definite provider rejection with `ChannelPostRejectedError`, and runtime policy failures with `ChannelRuntimeError`. Injected transports that throw `ChannelPostRejectedError` keep that type.

Gateway renewal is a scoped Effect `Schedule`. `startRenewingGateway` launches the first listener before it returns and fails with that launch's error if it fails, so the channel is never saved as connected without a listener. It then watches each listener for `CHANNEL_GATEWAY_RENEWAL_INTERVAL` (one hour) and relaunches at the deadline. Each relaunch aborts and awaits the previous listener first, so two listeners never run at once. A later listener that exits early or fails to launch leaves the gateway unhealthy and stops renewal. Shutdown closes the renewal scope, aborts the listener, and waits for the listener task. Tests drive renewal with `TestClock`.

Per-provider channel work, per-connection operations, connection settings, and per-bot binding updates are serialized by `makeKeyedLock`. It is a FIFO lock per key that releases the key after completion or interruption. An interrupted caller that is still waiting leaves the queue without blocking the callers behind it.

### Explicit project bindings

Every new `channel.attach` command names a live project explicitly. The server validates that the project is live before starting the provider runtime, so channel turns cannot silently move between workspaces. Existing bindings without a project remain readable and are shown as needing confirmation; operators can use `channel.change-project` to select a replacement. If a selected project is deleted or unavailable, the binding becomes `blocked` with the repair message “Choose another project” and inbound replies remain blocked until reassigned.

`channel.change-project` validates the target project, the binding, saved credentials, and identity availability before it stops the running runtime. If the new project fails to start, the server restarts the previous project when that binding was connected. If neither starts, the binding stays on its previous project with a failed or blocked status, so it is never half-switched. Clients share the picker rules in `@akeru/client-runtime/channel-presentation`: `channelBindingNeedsProject`, `channelPickerProjectId` (explicit choice, then the running project, then the `defaultProjectIdForBot` hint), and `canChangeChannelProject`. Web Settings, the bot Channels sheet, and the mobile chat Channels section all repair through `botEnvironment.channels.changeProject`.

## WhatsApp reachability

WhatsApp needs a public HTTPS origin, set with `--public-origin` or `T3CODE_PUBLIC_ORIGIN`. With one, the server writes `webhookUrl` (`/api/channels/whatsapp/connections/<connection-id>/webhook`) into the connection profile and marks the binding `connected`. Without one, the binding is `not-live`, the profile has no `webhookUrl`, and outbound sends still work. Restore rewrites or removes stale profile URLs when the origin changes. The per-bot webhook route still accepts calls for older Meta app configurations. Web surfaces the profile's `webhookUrl` only inside the `not-live` notice on the channel card, and never builds one from the browser origin.
