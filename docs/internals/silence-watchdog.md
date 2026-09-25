# Silence watchdog

A running turn that stops producing output is reported as a typed silent-run state instead of a spinner that keeps claiming the bot is working. The watchdog never interrupts the turn. The user decides whether to wait or stop it.

## Where it runs

The watchdog lives in `ProviderRuntimeIngestion`, after provider events are normalized into `ProviderRuntimeEvent`s. Every provider passes through that point. Codex and Kimi For Coding arrive through the Mastra `AgentController`, and Claude, Grok, and OpenCode arrive through the legacy adapter bridge. None of the providers needs its own watchdog code.

The timer itself is `startSilenceWatchdog` in `apps/server/src/orchestration/SilenceWatchdog.ts`. It is a fiber forked into the ingestion scope, driven by a signal queue and `Clock`, so tests control it with `TestClock`. The silent interval is the named constant `SILENCE_WATCHDOG_SILENT_MS` (90 seconds).

## Lifecycle

1. `turn.started` starts one watchdog for the thread and turn. A newer turn on the same thread stops the previous watchdog first.
2. Every other runtime event for the turn counts as output and restarts the countdown. `turn.completed` and `turn.aborted` do not; they end the turn instead.
3. `request.opened` and `user-input.requested` pause the countdown while the bot waits on the user. The matching `request.resolved` and `user-input.resolved` resume it with a fresh countdown, so time spent waiting on the user never counts as silence.
4. After 90 seconds without output, the watchdog appends a `turn.silent` activity with a `ThreadSilentRunActivityPayload` (`provider`, `lastActivityAt`) and opens a `silence-watchdog-failure` inbox item for the bot.
5. When output resumes, it appends `turn.silent.cleared` and resolves the inbox item. The countdown starts again, so a later quiet stretch opens a new silent window.
6. `turn.completed`, `turn.aborted`, and an interrupted turn stop the watchdog and resolve the inbox item. `session.exited` stops every watchdog for the thread. Stopping never appends `turn.silent.cleared`, because the turn ending already clears the state on clients.

Silent and cleared reports run on a drainable worker inside ingestion, so the ingestion `drain` covers them and tests can wait on it instead of sleeping.

## Inbox deduplication

The incident key is `silence:<threadId>:<turnId>`, so a turn has at most one inbox item. `BotInboxService.ensureOpen` reopens the existing item for this kind even after an automatic resolve, as long as nobody acknowledged it. Repeated silent windows in one turn therefore bump `occurrenceCount` on the same item instead of adding rows. A chat with no bot records the silent-run state but opens no inbox item.

## Clients

`packages/client-runtime/src/silentRun.ts` exports `threadSilentRun(activities, turnId)`. It returns the provider, its display name, and the last output time when the latest silent-run activity for the running turn is `turn.silent`, and `null` otherwise. Web passes the result to `BotActivityStatus`, which replaces the working shimmer with "No response from <provider>" and a timer counted from the last output. Mobile shows the same state in the working row of the thread feed. Both clients keep silent-run activities out of the work log.
