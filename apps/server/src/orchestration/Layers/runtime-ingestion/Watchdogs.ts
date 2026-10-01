import {
  CommandId,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  PROVIDER_DISPLAY_NAMES,
  THREAD_SILENT_RUN_ACTIVITY_KIND,
  THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND,
  type ProviderDriverKind,
  type ThreadSilentRunActivityPayload,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { makeDrainableWorker } from "@akeru/shared/DrainableWorker";
import { startSilenceWatchdog, type SilenceWatchdogHandle } from "../../SilenceWatchdog.ts";
import { resolveControllerBotId } from "../ProviderCommandReactor.ts";
import { providerTurnKey } from "./EventFields.ts";
import type { createDependencies } from "./Dependencies.ts";

export const createWatchdogs = Effect.fn("makeRuntimeWatchdogs")(function* ({
  botInbox,
  orchestrationEngine,
  projectionSnapshotQuery,
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>>,
  "botInbox" | "orchestrationEngine" | "projectionSnapshotQuery"
>) {
  const silenceWatchdogs = new Map<string, SilenceWatchdogHandle>();

  // Open requests per watched turn, so a duplicate or unmatched resolution cannot
  // resume a watchdog while another request still waits on the user.
  const silenceWaitingRequests = new Map<string, Set<string>>();

  const silenceIncidentKey = (threadId: ThreadId, turnId: TurnId) =>
    `silence:${threadId}:${turnId}`;

  const stopSilenceWatchdog = (threadId: ThreadId, turnId: TurnId) => {
    const key = providerTurnKey(threadId, turnId);
    const handle = silenceWatchdogs.get(key);

    if (!handle) return Effect.void;
    silenceWatchdogs.delete(key);
    silenceWaitingRequests.delete(key);

    return handle.stop;
  };

  const stopAllSilenceWatchdogs = (threadId: ThreadId) =>
    Effect.forEach(
      [...silenceWatchdogs.entries()].filter(([key]) => key.startsWith(`${threadId}:`)),
      ([key, handle]) =>
        Effect.sync(() => {
          silenceWatchdogs.delete(key);
          silenceWaitingRequests.delete(key);
        }).pipe(Effect.andThen(handle.stop)),
      { concurrency: 1, discard: true },
    );

  // Silent-run reports and their resolutions run in order on one worker, so a report
  // queued just before a turn ends can never reopen the incident the ending closed.
  const silenceReportWorker = yield* makeDrainableWorker((report: Effect.Effect<void>) => report);

  const resolveSilenceIncidents = (threadId: ThreadId) =>
    silenceReportWorker.enqueue(
      Effect.sync(() => {
        for (const incident of botInbox.list()) {
          if (
            incident.kind === "silence-watchdog-failure" &&
            incident.status === "open" &&
            incident.incidentKey.startsWith(`silence:${threadId}:`)
          ) {
            botInbox.resolve(incident.incidentKey);
          }
        }
      }),
    );

  const startTurnSilenceWatchdog = (
    thread: Pick<OrchestrationThreadShell, "id" | "botId" | "respondingBotId"> & {
      readonly title: string;
    },
    turnId: TurnId,
    provider: ProviderDriverKind,
  ) =>
    Effect.gen(function* () {
      // One turn runs per chat, so a new turn retires any watchdog left behind.
      yield* stopAllSilenceWatchdogs(thread.id);
      yield* resolveSilenceIncidents(thread.id);
      const botId = resolveControllerBotId(thread);
      const incidentKey = silenceIncidentKey(thread.id, turnId);
      const providerName = PROVIDER_DISPLAY_NAMES[provider] ?? provider;

      const appendSilenceActivity = (input: {
        readonly id: string;
        readonly kind: string;
        readonly summary: string;
        readonly payload: unknown;
      }) =>
        Effect.gen(function* () {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(input.id),
            threadId: thread.id,
            activity: {
              id: EventId.make(input.id),
              tone: "info",
              kind: input.kind,
              summary: input.summary,
              payload: input.payload,
              turnId,
              createdAt,
            },
            createdAt,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to record silent-run state", {
              threadId: thread.id,
              turnId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

      const handle = yield* startSilenceWatchdog({
        callbacks: {
          onSilent: (lastActivityAtMs) =>
            silenceReportWorker.enqueue(
              Effect.gen(function* () {
                const payload: ThreadSilentRunActivityPayload = {
                  provider,
                  lastActivityAt: DateTime.formatIso(DateTime.makeUnsafe(lastActivityAtMs)),
                };

                yield* appendSilenceActivity({
                  id: `silence-watchdog:silent:${thread.id}:${turnId}:${lastActivityAtMs}`,
                  kind: THREAD_SILENT_RUN_ACTIVITY_KIND,
                  summary: `No response from ${providerName}`,
                  payload,
                });

                if (botId === null) return;
                const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
                const bot = snapshot.bots.find((candidate) => candidate.id === botId);

                if (!bot) return;
                // Keyed by chat and turn: a later silent window reopens the same item.
                yield* Effect.sync(() =>
                  botInbox.ensureOpen({
                    incidentKey,
                    kind: "silence-watchdog-failure",
                    botId,
                    botName: bot.name,
                    taskOrRoutine: thread.title,
                    lastFailure: `No response from ${providerName} for over a minute while the chat is running.`,
                    nextAction:
                      "Wait for it to continue, or stop the chat and send your message again. If it keeps happening, check the provider connection.",
                  }),
                );
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to report silent run", {
                    threadId: thread.id,
                    turnId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              ),
            ),
          onResumed: silenceReportWorker.enqueue(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              yield* appendSilenceActivity({
                id: `silence-watchdog:cleared:${thread.id}:${turnId}:${now}`,
                kind: THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND,
                summary: `${providerName} responded`,
                payload: { provider },
              });
              yield* Effect.sync(() => botInbox.resolve(incidentKey));
            }),
          ),
        },
      });

      silenceWatchdogs.set(providerTurnKey(thread.id, turnId), handle);
    });

  return {
    silenceWatchdogs,
    silenceWaitingRequests,
    silenceIncidentKey,
    stopSilenceWatchdog,
    stopAllSilenceWatchdogs,
    silenceReportWorker,
    resolveSilenceIncidents,
    startTurnSilenceWatchdog,
  };
});
