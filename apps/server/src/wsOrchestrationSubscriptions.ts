import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { type OrchestrationEvent, OrchestrationGetSnapshotError, ORCHESTRATION_WS_METHODS, WsRpcGroup } from "@akeru/contracts";
import { projectActivityEvent, projectThreadDetailSnapshot } from "./orchestration/ActivityPayloadProjection.ts";
import { makeThreadLiveEventCoalescer } from "./orchestration/ThreadLiveEventCoalescer.ts";
import { makeLiveStreamBudget, type RetainedLiveItem } from "./orchestration/LiveStreamBudget.ts";

import { isThreadDetailEvent, toShellSourceEvent, createSentThreadShells, SHELL_RESUME_MAX_GAP, THREAD_RESUME_MAX_EVENTS, ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES } from "./wsSupport.ts";
import type { WsConnection } from "./wsConnection.ts";
import type { ShellLiveInput } from "./wsOrchestrationStreams.ts";

export const createWsOrchestrationSubscriptions = ({ projectionSnapshotQuery, orchestrationEngine, canReplayPersistedRange, channelBindingsForRuntime, observeRpcStreamEffect, loadEnvironmentPeople, SHELL_COALESCE_WINDOW, SHELL_COALESCE_MAX_CHUNK, coalesceShellStream, coalesceShellLiveInputs }: Pick<WsConnection, "projectionSnapshotQuery" | "orchestrationEngine" | "canReplayPersistedRange" | "channelBindingsForRuntime" | "observeRpcStreamEffect" | "loadEnvironmentPeople" | "SHELL_COALESCE_WINDOW" | "SHELL_COALESCE_MAX_CHUNK" | "coalesceShellStream" | "coalesceShellLiveInputs">) => ({

        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              // Coalesce the live shell stream per aggregate over a small window
              // so bursts of high-frequency events (streaming message deltas,
              // activity appends) collapse into a single shell refetch and never
              // serialize a brand-new thread's `thread.created` behind hundreds
              // of per-event DB reads. See coalesceShellStream.
              // Attach live delivery into a scope-bound buffer BEFORE loading any
              // snapshot or draining catch-up, otherwise an event published while
              // the snapshot query is in flight is lost (it is past the snapshot's
              // sequence but the live subscription is not attached yet). Every
              // path below emits from this same buffered live tail. Overlapping
              // events are deduped by sequence on the client.
              const liveBudget = yield* makeLiveStreamBudget();
              const sentThreads = createSentThreadShells();
              const liveBuffer = yield* Queue.unbounded<
                RetainedLiveItem<ShellLiveInput>,
                OrchestrationGetSnapshotError
              >();
              let liveBufferClosed = false;
              const closeLiveBuffer = (error?: OrchestrationGetSnapshotError) =>
                Effect.gen(function* () {
                  if (liveBufferClosed) {
                    return;
                  }
                  liveBufferClosed = true;
                  liveBudget.release(yield* Queue.clear(liveBuffer).pipe(Effect.orDie));
                  if (error) {
                    yield* Queue.fail(liveBuffer, error);
                  }
                  yield* Queue.shutdown(liveBuffer);
                });
              yield* Effect.addFinalizer(() => closeLiveBuffer());
              yield* liveBudget.failed.pipe(
                Effect.catchTags({ OrchestrationGetSnapshotError: closeLiveBuffer }),
                Effect.forkScoped,
              );
              yield* Effect.forkScoped(
                orchestrationEngine.streamDomainEvents.pipe(
                  Stream.runForEach((event) =>
                    // Retain only what the shell reads. A thread refetch needs
                    // the thread id and sequence, not a large message or tool
                    // payload, so the budget charges the small reference.
                    liveBudget
                      .retain({ kind: "event" as const, event: toShellSourceEvent(event) })
                      .pipe(
                        Effect.flatMap((item) => Queue.offer(liveBuffer, item)),
                        Effect.uninterruptible,
                      ),
                  ),
                  // Stop the PubSub consumer even if RPC delivery is waiting
                  // for an ACK and never pulls the failed buffer again.
                  Effect.raceFirst(liveBudget.failed),
                  Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
                ),
                { startImmediately: true },
              );
              const coalesceRetainedInputs = (
                items: ReadonlyArray<RetainedLiveItem<ShellLiveInput>>,
              ) =>
                coalesceShellLiveInputs(
                  items.map((item) => item.value),
                  sentThreads,
                ).pipe(Effect.flatMap((output) => liveBudget.replace(items, output)));
              const bufferedLiveStream = Stream.fromQueue(liveBuffer).pipe(
                Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
                Stream.mapEffect(coalesceRetainedInputs),
                Stream.flatMap((items) => Stream.fromIterable(items)),
              );

              const loadSnapshot = Effect.all({
                snapshot: projectionSnapshotQuery.getShellSnapshot(),
                people: loadEnvironmentPeople(),
              }).pipe(
                Effect.map(({ snapshot, people }) => ({
                  ...snapshot,
                  currentPersonId: people.current.personId,
                  currentPersonDisplayName: people.current.displayName,
                  ...(people.host === undefined
                    ? {}
                    : {
                        environmentHostPersonId: people.host.personId,
                        environmentHostDisplayName: people.host.displayName,
                      }),
                  bots: snapshot.bots.map((bot) => ({
                    ...bot,
                    channelBindings: channelBindingsForRuntime(bot.channelBindings ?? []),
                  })),
                })),
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              // Offer the completion marker into the same queue as live events.
              // Anything buffered while snapshot/replay work was in flight is
              // therefore delivered before the client is told it is synchronized.
              const synchronizedThenLive = liveBudget.deliver(
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        liveBudget.retain({ kind: "synchronized" as const }).pipe(
                          Effect.flatMap((item) => Queue.offer(liveBuffer, item)),
                          Effect.uninterruptible,
                          Effect.andThen(Queue.takeAll(liveBuffer)),
                          Effect.flatMap(coalesceRetainedInputs),
                        ),
                      ).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream,
              );

              // When the client already holds a shell snapshot (cached, or loaded
              // over HTTP) it passes that snapshot's sequence, and we resume by
              // replaying shell events after it instead of re-sending the whole
              // projects/threads list over the socket. If the client is too far
              // behind, we fall back to a fresh snapshot instead of an unbounded
              // replay (see below).
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                // Gap too large: replaying every intervening event (each a shell
                // refetch) is far more expensive than a single O(active-threads)
                // snapshot. A cursor ahead of this engine's authoritative state
                // is also invalid, so reset it with a snapshot. Send the snapshot
                // followed by the buffered live tail, exactly as the
                // no-afterSequence path does.
                if (
                  !(yield* canReplayPersistedRange(
                    afterSequence,
                    headSequence,
                    SHELL_RESUME_MAX_GAP,
                  ))
                ) {
                  const snapshot = yield* loadSnapshot;
                  return Stream.concat(
                    Stream.make({ kind: "snapshot" as const, snapshot }),
                    synchronizedThenLive,
                  );
                }
                const catchUpStream = coalesceShellStream(
                  // Replay only through the head captured above. Newer events
                  // are already covered by the live subscription, so this bound
                  // cannot chase a moving event-store head or grow the live
                  // buffer indefinitely while waiting for an empty page.
                  orchestrationEngine.readEvents(afterSequence, replayGap, headSequence),
                  sentThreads,
                ).pipe(
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to replay orchestration shell events",
                        cause,
                      }),
                  ),
                );
                return Stream.concat(catchUpStream, synchronizedThenLive);
              }

              const snapshot = yield* loadSnapshot;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot,
                }),
                synchronizedThenLive,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),

        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === input.threadId &&
                isThreadDetailEvent(event);

              const liveStream = orchestrationEngine.streamDomainEvents.pipe(
                Stream.filter(isThisThreadDetailEvent),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event,
                })),
              );

              // Attach live delivery before reading either replay or snapshot state.
              // Otherwise an event published while the snapshot is loading is lost.
              const liveBuffer = yield* makeThreadLiveEventCoalescer();
              yield* Effect.forkScoped(
                liveStream.pipe(
                  Stream.runForEachArray(liveBuffer.offerAll),
                  Effect.raceFirst(liveBuffer.failed),
                  Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
                ),
                { startImmediately: true },
              );
              const bufferedLiveStream = liveBuffer.stream;
              let replayOnMissingSnapshot: typeof bufferedLiveStream | undefined;

              // When the client already loaded the snapshot over HTTP it passes
              // that snapshot's sequence, and we resume the live subscription by
              // replaying persisted events after it instead of re-sending the
              // (potentially multi-KB) snapshot frame over the socket.
              //
              // The live PubSub subscription must be attached *before* draining
              // the catch-up replay, otherwise events published during the replay
              // window are dropped (they are past the persisted tail the replay
              // read, but the live stream is not yet subscribed). So fork the
              // live stream into a buffer bound to this stream's scope, then emit
              // catch-up followed by the buffered/ongoing live events. Overlapping
              // events are deduped by sequence on the client.
              //
              // Measure only this thread's rows. Global sequence gaps can
              // contain unrelated or pruned streams. Keep an explicit upper
              // bound so events after the captured head stay in the live tail.
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const range = {
                  threadId: input.threadId,
                  fromSequenceExclusive: afterSequence,
                  toSequenceInclusive: headSequence,
                };
                const replayStats =
                  afterSequence > headSequence
                    ? null
                    : yield* orchestrationEngine
                        .getThreadReplayStats({
                          ...range,
                          maxEvents: THREAD_RESUME_MAX_EVENTS,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new OrchestrationGetSnapshotError({
                                message: `Failed to measure chat ${input.threadId} replay range`,
                                cause,
                              }),
                          ),
                        );
                if (
                  replayStats !== null &&
                  replayStats.eventCount <= THREAD_RESUME_MAX_EVENTS &&
                  replayStats.payloadBytes <= ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES
                ) {
                  const catchUpStream = orchestrationEngine
                    .readThreadEvents({ ...range, limit: THREAD_RESUME_MAX_EVENTS })
                    .pipe(
                      Stream.filter(isThisThreadDetailEvent),
                      Stream.map((event) => ({
                        kind: "event" as const,
                        event: projectActivityEvent(event),
                      })),
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to restore chat ${input.threadId}`,
                            cause,
                          }),
                      ),
                    );
                  const afterCatchUp =
                    input.requestCompletionMarker === true
                      ? Stream.unwrap(
                          liveBuffer
                            .offer({ kind: "synchronized" as const })
                            .pipe(Effect.as(bufferedLiveStream)),
                        )
                      : bufferedLiveStream;
                  const replay = Stream.concat(catchUpStream, afterCatchUp);
                  if (!replayStats.hasCreateEvent) {
                    return replay;
                  }
                  replayOnMissingSnapshot = replay;
                }
                // A recreated thread needs a fresh snapshot if it still exists.
                // Oversized replays and invalid cursors also use the snapshot path.
              }

              const snapshot = yield* projectionSnapshotQuery
                .getThreadDetailSnapshot(
                  input.threadId,
                  // Windowing the fallback snapshot is opt-in per subscription:
                  // clients that don't send turnLimit (including all
                  // pre-pagination clients) get the full thread, since they
                  // have no way to load older pages.
                  input.turnLimit === undefined ? undefined : { turnLimit: input.turnLimit },
                )
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load chat ${input.threadId}`,
                        cause,
                      }),
                  ),
                );

              if (Option.isNone(snapshot)) {
                // The recreated thread can already be deleted. Preserve the
                // bounded replay and shell removal instead of retrying a
                // snapshot that cannot exist. Oversized ranges still fail.
                if (replayOnMissingSnapshot !== undefined) {
                  return replayOnMissingSnapshot;
                }
                return yield* new OrchestrationGetSnapshotError({
                  message: `Chat ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              const afterSnapshot =
                input.requestCompletionMarker === true
                  ? Stream.unwrap(
                      liveBuffer
                        .offer({ kind: "synchronized" as const })
                        .pipe(Effect.as(bufferedLiveStream)),
                    )
                  : bufferedLiveStream;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: projectThreadDetailSnapshot(snapshot.value),
                }),
                afterSnapshot,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          )
} satisfies Pick<RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>, typeof ORCHESTRATION_WS_METHODS.subscribeShell | typeof ORCHESTRATION_WS_METHODS.subscribeThread>);
