# Delegation threads

Delegated work runs in a child thread so the work card can link to its full
execution history. The child thread carries `parentThreadId` and
`parentDelegationId` on its creation command, event payload, read model, and
shell. Both fields are nullable and optional at the decode boundary so events
and clients from before this feature continue to replay.

Parent-linked threads are execution details, not a bot's user conversation.
Navigation selectors, roster message derivation, the web sidebar, mobile
thread lists, and server thread search therefore omit them. Work cards retain
the child thread id and remain the supported path to open that detail.

The web roster also remembers each bot's last chat path. Because a remembered
path can point at a thread that is not in the child-free shell list yet,
`useBotChatTarget` checks the target's own shell and drops it when the shell is
parent-linked or belongs to another bot. A bot with only child threads resolves
to no chat, so selecting it starts its direct chat. The work view's **Open
chat** navigates to the child bot's route rather than the child thread.

## Record fields for placement, retry, and triggers

Three fields on `AkeruDelegationRecord` support work cards in the chat and
scheduled delegation. Each has a decoding default, so records written before
the fields existed decode unchanged. Records are stored as JSON, so no
migration was needed.

- `anchorMessageId` is the user message that started the parent turn. `send()`
  reads it from the parent thread's `latestTurn.requestMessageId` when that
  turn matches the delegation's `parentTurnId`, and leaves it `null`
  otherwise. Old records default to `null`.
- `retryOfDelegationId` points at the delegation a retry replaces. A retry is
  always a new record; the original is never mutated. Defaults to `null`.
- `trigger` is `"bot"` for work a bot started with `SendToAgent` and
  `"scheduled"` for work a routine started. Defaults to `"bot"`.

`botChatTimeline` in `@t3tools/client-runtime/state/bot-chat-timeline` merges a
chat's messages, receipts, and delegations into one ordered list for web and
mobile. A card goes after its turn: after the anchor message and any later
message in the same `parentTurnId`. Without a known anchor it goes after the
turn's last message, and without either it goes at the end of the chat. Cards
at the same spot keep creation order.

Routines carry `delegateToBotId`, the bot a scheduled run hands its work to.
It defaults to `null`, meaning the routine's own bot does the work, and is
stored in the `delegate_to_bot_id` column of `projection_routines` (migration
71).

## Lifecycle

`SendToAgent` returns a handle as soon as the child thread and its first turn
are dispatched. The handle carries `delegationId`, `childThreadId`,
`childBotId`, the bot name, and `phase: "running"`. The parent turn keeps going
and usually replies before the child finishes.

`AkeruDelegationRuntime` watches each child in the background. When the child
turn ends it records the outcome as a `delegation.updated` event with a
`Completed` or `Failed` phase and `acknowledgedAt: null`, then appends an
activity to the parent chat. Mastra child turns report through the controller's
turn result. Every provider that can receive delegated work runs on the
controller, so no child turn reports through the legacy bridge. `drain()` resolves once every background watch has
recorded its outcome, so tests wait on it instead of sleeping.

A child started by a parent turn that later completes keeps running. When a
parent turn is interrupted, the runtime cancels the children that turn started.
When it fails, the runtime fails them with `parent_failed` and interrupts their
turns. Children marked `keep` survive both. Only children whose `parentTurnId`
matches the ended turn are settled, so work started by earlier turns is never
touched.

## Child waiters and timeouts

`AgentController` keeps one waiter per running child thread in a
`PendingWaiters` registry (`apps/server/src/provider/PendingWaiters.ts`). Each
waiter is an Effect `Deferred` awaited under `Effect.timeoutOrElse`, so no wait
is unbounded:

- A delegation with a `deadline` times out at the deadline with the message
  "The delegation deadline expired." A deadline already in the past fails at
  once.
- A delegation with no deadline times out after
  `AKERU_CHILD_WAIT_DEFAULT_TIMEOUT` (4 hours). Coding work can run for hours,
  so the bound catches a child that never reports back rather than a slow one.

Both cases reject `awaitChild` with `PendingWaiterTimeoutError`. The runtime
records that as a `Failed` phase with failure code `timeout` and interrupts
the child turn, so the card shows a timeout instead of running forever.

The registry lives in the controller layer's scope. When the layer shuts down,
its finalizer fails every outstanding waiter with `PendingWaiterClosedError`
("The agent controller stopped.").

Routine reviews use the same registry type. `createRoutine` opens a
`dynamic_tool_call` request and waits up to `AKERU_ROUTINE_REVIEW_TIMEOUT`
(1 hour) for the user's answer. An answer claims the review before the routine
is created, which stops the timeout, so an answer that arrives in time decides
the outcome even when creation finishes after the limit. The tool call then
returns the created routine or the creation error. On timeout the controller
resolves the request as a system cancellation (`actor: "system"`,
`outcome: "cancelled"`), returns the session to `running`, and the tool call
fails with a message the bot relays. An answer that arrives after the timeout
is rejected as stale and creates nothing. A turn that ends first rejects its
open reviews, and layer shutdown fails any that remain. Routine reviews run only on the Mastra
path (Codex, Claude, Grok, Kimi For Coding, OpenCode Go).

## Waiting on children

`isThreadWaitingOnChildren` in `@t3tools/contracts` is true while any
delegation for the thread is queued, running, or blocked. The flag is derived
from the read model and never persisted. Web and mobile read it through
`@t3tools/client-runtime/delegation-presentation`, which also derives each
card's delivery state.

## Result delivery

A finished result is delivered to the parent bot exactly once, in one of two
ways.

- **The next parent turn.** The decider handles `thread.turn.start` by finding
  every `Completed` or `Failed` delegation of that thread with
  `acknowledgedAt: null`. In the same command it emits `delegation.updated`
  with `acknowledgedAt` set for each one and lists their ids in the turn
  start event's `acknowledgedDelegationIds`. Because acknowledgement and turn
  start are one persisted step, a restart replays the same state and cannot
  deliver a result twice or lose one. `ProviderCommandReactor` reads those
  records and passes them to the provider as `delegationResults`, formatted by
  `delegationResultsContext`. Each summary is shortened to about 4,000
  characters; the card keeps the full text.
- **`CheckAgent`.** The tool returns each delegation's `state` and `summary`
  (the result summary or failure message). Reading a finished, unacknowledged
  result acknowledges it, so the next turn does not repeat it.

If the parent never takes another turn, the result stays pending and the card
says it is waiting for the next reply. If the turn start fails before its
provider reads the results, `ProviderCommandReactor` releases their
acknowledgement so the next parent turn receives them, retrying in the
background when the release cannot land at once. It records the
`provider.turn.start.failed` activity before the session error clears the
pending turn start, so after a restart startup recovery either replays that
turn start or finds the failure and releases the results it acknowledged.
Canceled delegations have no result to deliver.

## Provider injection

| Provider        | Path          | Where `delegationResults` goes     |
| --------------- | ------------- | ---------------------------------- |
| Codex           | Mastra        | Per-turn `persistentMemoryContext` |
| Kimi For Coding | Mastra        | Per-turn `persistentMemoryContext` |
| Claude          | Mastra        | Per-turn `persistentMemoryContext` |
| Grok            | Mastra        | Per-turn `persistentMemoryContext` |
| OpenCode Go     | Mastra        | Per-turn `persistentMemoryContext` |
| OpenCode        | Legacy bridge | Cannot delegate                    |

`driverSupportsDelegation` in `@t3tools/shared/delegationProviders` names the
drivers in the Mastra rows. `AgentController` uses the same predicate to route
a turn to the controller, so a driver that gets the Akeru tool catalog is
exactly a driver that can delegate. `delegationProviderMatrix.test.ts` runs
send, access grant, result, usage, cancel, and the depth cap against each of
the five.

## Legacy bridge providers

Standard OpenCode runs on the legacy bridge, which registers no tool session.
Its bots never see `SendToAgent` or the other delegation tools. A bot on
another provider that sends work to an OpenCode bot is refused before any child
thread exists: `send` resolves the target's driver through the
`providerDriverKind` option and throws
`AkeruDelegationProviderUnsupportedError`, which the tool runtime reports with
failure code `denied`. The message names the target bot and tells the sender
to do the work itself or pick a bot on another provider. When
`providerDriverKind` returns `null` because the target's provider instance no
longer exists, `send` refuses with "The target bot is not available in this
workspace." and also creates nothing.

Clients show the same limit before anyone asks. On web, the bot Tools sheet
shows a note for a bot whose provider cannot hand off work, and the group
`@` picker marks such a bot with "Cannot take handed-off work"
(`botEngineTakesDelegatedWork` in `botEngineSelection.ts`). On mobile, the
group `@` picker adds the same marker (`groupMentionBots` in
`composerMentionItems.ts`), and chat settings show the Tools note under
Options. Both use `driverSupportsDelegation`. A bot without an engine, or
whose provider instance the client cannot find, is not marked. MCP bot tools
for the legacy bridge are tracked separately.

## Groups

A bot in a group chat can send work only to bots that are members of that
group. `send` checks membership before it creates anything and fails with
"The target bot is not available in the current group." A direct chat can
send work to any available bot.

The child always runs in a direct thread with the target's `botId` and
`groupId: null`, even when the parent is a group chat. When the child
completes, the runtime records the result as usual and then posts a
server-authored assistant message to the group:
`Finished work for {parent bot}: {task}` followed by the summary. The message
has ID `delegation-result-{id}` and `respondingBotId` set to the child bot, so
the group shows it from the bot that did the work. It starts no turn. The
runtime reads the parent bot's name when the child completes, so a rename
during the work shows the current name.

The delegation stays completed even when the group cannot take the result.
If the child bot left the group, was archived, or the group is gone, the
runtime skips the post and calls `onGroupResultSkipped` with
`bot_left_group` or `group_unavailable`. `AgentController` logs that at info
level. The runtime checks before it posts and again when the decider refuses
the message, so a member removed mid-post is reported the same way. Any other
delivery error goes to `onWatchError`.

## Channel turns

When the parent turn started from an external channel message, the turn start
message carries a `channelOrigin`. `ProviderCommandReactor` then formats
pending results with `delegationResultsContext(..., { channel: true })`, which
uses `delegationSummaryText` from `@t3tools/shared` to write plain-text lines
without Markdown. Akeru never starts a follow-up turn when delegated work
finishes, so the external sender sees the result in the reply to their next
message.

## Request limits

- `context` is optional free text the parent passes to the child. It is capped
  at `AKERU_DELEGATION_CONTEXT_MAX_CHARS` (8,000). The runtime rejects longer
  context with `AkeruDelegationContextTooLongError`, which the tool runtime
  reports with failure code `validation`.
- `memoryScopes` is an allowlist. Each requested scope must be one the parent
  turn holds, or the request fails. An omitted list grants the child no memory
  scopes.
- A parent thread can have at most `AKERU_DELEGATION_MAX_CONCURRENCY` (3)
  active delegations, and delegation nests at most
  `AKERU_DELEGATION_MAX_DEPTH` (2) levels.

## Sending to the same bot again

A second `SendToAgent` to a bot that already has work from the same parent is
allowed. It creates a new delegation with its own child thread and returns its
own handle. The earlier work is not replaced or merged. Both count toward the
concurrency cap, and each result is delivered separately.

## Temporary workers are not delegations

`Task`, `CheckSubagent`, `MessageSubagent`, and `StopSubagent` start a
temporary worker inside the parent's own turn. The worker is a copy of the
bot under a narrower grant, not a delegation to another bot, so it is not
covered by this document's acknowledgement and delivery rules. See
[Temporary workers](providers.md#temporary-workers) in providers.md.

## Reverse states

Every way into a delegation state has a way back out.

- **Cancel.** `delegation.cancel` with `keep: false` moves live work to
  `Canceled` with `canceledBy: "user"`. It does nothing to work that has
  already finished.
- **Let it finish.** `delegation.cancel` with `keep: true` only sets `keep` on
  the record, and the work keeps running. A kept child survives its parent turn
  being interrupted or failing. A bot can set the same flag up front with
  `keep: true` on `SendToAgent`.
- **Retry.** `delegation.retry` starts new work from a `Failed` or `Canceled`
  record. The decider refuses any other phase, a record that another record
  already retries (its `retryOfDelegationId` points at it), and a retry when
  the parent chat already has `AKERU_DELEGATION_MAX_CONCURRENCY` active
  delegations. The refusals are `OrchestrationCommandInvariantError`s whose
  detail is readable text. Once a retry exists, the original is superseded: a
  later retry has to start from the newest record. An accepted retry emits
  `delegation.retry-requested` and leaves the original record untouched.
  `ProviderCommandReactor` then calls `AgentController.dispatchDelegation`
  with `{ _tag: "Retry" }`. The runtime sends a new delegation to the same bot
  with the original task, expected result, access grant, `keep`, `trigger`,
  and anchor, plus `retryOfDelegationId` pointing at the original. A deadline
  carries over only if it is still in the future. The original `context` is
  not stored on the record, so a retry runs without it. Storing it would put up
  to 8,000 characters on every record sent to clients. If the runtime refuses
  the new work, the reactor appends a `delegation.retry.failed` activity to
  the parent chat with the reason.

`delegationActions(record, delegations)` in
`@t3tools/client-runtime/delegationPresentation` lists the actions a work card
offers, given the chat's delegations. Live work offers `keep`, unless it is
already kept, and `cancel` when `AKERU_DELEGATION_TRANSITIONS` allows it.
Failed and canceled work offers `retry` unless `isDelegationSuperseded` finds a
record that already retries it, which matches the decider's rule. Completed
work offers nothing. Clients send the actions with the `cancelDelegation` and
`retryDelegation` orchestration commands.

On web, `DelegationCard` takes the chat's `delegations` and renders one button
per action in its actions slot (Let it finish, Cancel, Try again), disables them
all while a command is in flight, and shows the decider's refusal text in an
error toast. On mobile, `buildThreadFeed` stores each card's actions on its feed
entry, and `ThreadDelegationFeedCard` sends the same commands. The buttons
disable while a command is in flight, and a refusal shows in an alert with the
server's text.

## Scheduled delegation

A routine with `delegateToBotId` hands each run to that bot instead of running
a turn in its own chat. The routines runtime adapter calls
`AgentController.dispatchDelegation` with `{ _tag: "Scheduled" }`. The runtime
records the delegation with `trigger: "scheduled"`, parented on the routine's
chat with depth 0 and the owner bot's default grant. The run's approval policy
sets the runtime mode. The card anchors to the chat's last message when the
routine fired. The run's `threadRef` is the child thread, which is how the
runtime links the run to its delegation.

- A `Completed` delegation completes the run with the result summary.
- A `Failed` delegation fails the run, opens an incident, and blocks the
  routine.
- A `Canceled` delegation cancels the run.
- Canceling the run cancels its delegation. A run canceled while its
  delegation is still starting has no `threadRef` yet. The decider refuses
  `routine.run.start` for a run that already ended, and the adapter then
  cancels the new delegation by the `delegationId` the runtime returned.
- Pausing or disabling the routine leaves running work alone. The pause only
  stops future runs.
- The web **Done by** picker leaves out the routine's own bot and lists bots
  whose provider cannot take handed-off work as disabled options, using
  `routineDelegateOptions` in `botEngineSelection.ts`. Mobile only shows the
  saved helper's name, so it has no picker to filter.
- `checkDependencies` blocks a run up front, with "pick another bot"
  guidance, when the delegate bot is archived or missing, is the routine's own
  bot, or runs on a provider where `driverSupportsDelegation` is false (standard
  OpenCode). A run whose delegation the runtime still refuses is blocked with
  the runtime's reason.

Scheduled work has no live parent turn. Ending a turn in the routine's chat
therefore never cancels it.

A delegation that ends while the server is down, or before `routine.run.start`
records the run's `threadRef`, does not settle the run. Recovering those runs after a restart is
follow-up work.
