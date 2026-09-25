# Delegation threads

Delegated work runs in a child thread so the work card can link to its full
execution history. The child thread carries `parentThreadId` and
`parentDelegationId` on its creation command, event payload, read model, and
shell. Both fields are nullable and optional at the decode boundary so events
and clients from before this feature continue to replay.

Parent-linked threads are execution details, not a bot's user conversation.
Navigation selectors, roster message derivation, the web sidebar, and mobile
thread lists therefore omit them. Work cards retain the child thread id and
remain the supported path to open that detail.

## Lifecycle

`SendToAgent` returns a handle as soon as the child thread and its first turn
are dispatched. The handle carries `delegationId`, `childThreadId`,
`childBotId`, the bot name, and `phase: "running"`. The parent turn keeps going
and usually replies before the child finishes.

`AkeruDelegationRuntime` watches each child in the background. When the child
turn ends it records the outcome as a `delegation.updated` event with a
`Completed` or `Failed` phase and `acknowledgedAt: null`, then appends an
activity to the parent chat. Mastra child turns report through the controller's
turn result. Legacy child turns (Claude, Grok, OpenCode) report through the
delegation waiter that `settleLegacyTurnMemory` resolves when the child's
`turn.completed` arrives. `drain()` resolves once every background watch has
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
path (Codex, Kimi For Coding).

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

| Provider        | Path          | Where `delegationResults` goes                          |
| --------------- | ------------- | ------------------------------------------------------- |
| Codex           | Mastra        | Per-turn `persistentMemoryContext`                      |
| Kimi For Coding | Mastra        | Per-turn `persistentMemoryContext`                      |
| OpenCode        | Legacy bridge | Per-turn context, which OpenCode reads as system prompt |
| Claude          | Legacy bridge | Prepended to the turn input                             |
| Grok            | Legacy bridge | Prepended to the turn input                             |

Claude and Grok only read session context when the session starts, so the
results travel with the turn text instead.

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
