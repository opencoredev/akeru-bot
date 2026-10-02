import * as Match from "effect/Match";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  type ConnectionAttemptError,
  type ConnectionTarget,
  ConnectionTransientError,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const Outcome = Data.taggedEnum<AttemptOutcome>();

const Establishment = Data.taggedEnum<EstablishmentEvent>();

const Signal = Data.taggedEnum<SupervisorSignal>();

const RETRY_DELAYS_MS = [3_000, 4_000, 8_000, 16_000] as const;

const CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds";

const CONNECTION_PROBE_TIMEOUT = "15 seconds";

const MOBILE_CONNECTION_PROBE_TIMEOUT = "3 seconds";

const BACKOFF_RESET_AFTER_MS = 30_000;

interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

type SupervisorSignal =
  | { readonly _tag: "ConnectRequested" }
  | { readonly _tag: "DisconnectRequested" }
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "NetworkChanged"; readonly network: NetworkStatus }
  | { readonly _tag: "Wakeup"; readonly reason: ConnectionWakeups.ConnectionWakeup };

type AttemptOutcome =
  | {
      readonly _tag: "Interrupted";
      readonly established: boolean;
      readonly stable: boolean;
      readonly resetRetry: boolean;
    }
  | {
      readonly _tag: "Failure";
      readonly established: boolean;
      readonly stable: boolean;
      readonly failure: ConnectionAttemptError;
    };

type EstablishmentEvent =
  | {
      readonly _tag: "Completed";
      readonly exit: Exit.Exit<ConnectionDriver.EnvironmentConnectionLease, ConnectionAttemptError>;
    }
  | { readonly _tag: "Interrupted"; readonly resetRetry: boolean }
  | { readonly _tag: "TimedOut" };

function exitUnlessInterrupted<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Exit.Exit<A, E>, never, R> {
  return Effect.matchCauseEffect(effect, {
    onFailure: (cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Exit.failCause(cause)),
    onSuccess: (value) => Effect.succeed(Exit.succeed(value)),
  });
}

export interface EnvironmentSupervisorOptions {
  readonly initiallyDesired?: boolean;
}

function retryDelayMs(failureCount: number): number {
  return RETRY_DELAYS_MS[Math.min(failureCount, RETRY_DELAYS_MS.length - 1)] ?? 16_000;
}

function annotateTarget(target: ConnectionTarget) {
  return Effect.annotateCurrentSpan({
    "environment.id": target.environmentId,
    "environment.label": target.label,
    "environment.target.kind": target._tag,
  });
}

function availableState(intent: SupervisorIntent, generation: number): SupervisorConnectionState {
  return {
    desired: false,
    network: intent.network,
    phase: "available",
    stage: null,
    attempt: 0,
    generation,
    lastFailure: null,
    retryAt: null,
  };
}

function offlineState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "offline",
    stage: null,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function connectingState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
  stage: SupervisorConnectionState["stage"] = "preparing",
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "connecting",
    stage,
    attempt,
    generation,
    lastFailure,
    retryAt: null,
  };
}

function failureFromExit<A>(
  target: ConnectionTarget,
  exit: Exit.Exit<A, ConnectionAttemptError>,
  established: boolean,
  stable: boolean,
): AttemptOutcome {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
    return Outcome.Interrupted({ established, stable, resetRetry: false });
  }

  const typedFailure = exit.cause.reasons.find(Cause.isFailReason);

  if (typedFailure) {
    return Outcome.Failure({ established, stable, failure: typedFailure.error });
  }

  return Outcome.Failure({
    established,
    stable,
    failure: new ConnectionTransientError({
      reason: "transport",
      detail: `${target.label} connection failed unexpectedly.`,
    }),
  });
}

export class EnvironmentSupervisor extends Context.Service<
  EnvironmentSupervisor,
  {
    readonly target: ConnectionTarget;
    readonly state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    readonly prepared: SubscriptionRef.SubscriptionRef<Option.Option<PreparedConnection>>;
    readonly connect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly retryNow: Effect.Effect<void>;
    /** Retries only while connection is still desired, leaving intent unchanged. */
    readonly retryIfDesired: Effect.Effect<void>;
  }
>()("@akeru/client-runtime/connection/supervisor/EnvironmentSupervisor") {}

export const make = Effect.fn("EnvironmentSupervisor.make")(function* (
  entry: ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
): Effect.fn.Return<
  EnvironmentSupervisor["Service"],
  never,
  | Connectivity.Connectivity
  | ConnectionDriver.ConnectionDriver
  | Scope.Scope
  | ConnectionWakeups.ConnectionWakeups
> {
  const target = entry.target;
  yield* annotateTarget(target);

  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;

  const initialIntent: SupervisorIntent = {
    desired: options?.initiallyDesired ?? false,
    network: yield* connectivity.status,
  };

  const intent = yield* Ref.make(initialIntent);
  const signals = yield* Queue.unbounded<SupervisorSignal>();
  const resetRetryState = yield* Ref.make(false);
  // Set when a foreground wake probe fails or times out: the user is actively
  // returning to the app on a dead transport, so the follow-up reconnect skips
  // the first backoff rung instead of sleeping.
  const wakeProbeFailed = yield* Ref.make(false);

  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(
    !initialIntent.desired
      ? availableState(initialIntent, 0)
      : initialIntent.network === "offline"
        ? offlineState(initialIntent, 0, 0, null)
        : connectingState(initialIntent, 0, 1, null),
  );

  const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none());
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());

  const clearLease = Effect.all(
    [SubscriptionRef.set(session, Option.none()), SubscriptionRef.set(prepared, Option.none())],
    { discard: true },
  );

  const setState = Effect.fn("EnvironmentSupervisor.setState")(function* (
    next: SupervisorConnectionState,
  ) {
    yield* SubscriptionRef.set(state, next);
  });

  const signal = Effect.fn("EnvironmentSupervisor.signal")(function* (next: SupervisorSignal) {
    yield* Queue.offer(signals, next);
  });

  const reportProgress = Effect.fn("EnvironmentSupervisor.reportProgress")(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
    progress: ConnectionDriver.ConnectionDriverProgress,
  ) {
    if ("prepared" in progress) {
      yield* SubscriptionRef.set(prepared, Option.some(progress.prepared));
    }

    yield* setState(
      connectingState(yield* Ref.get(intent), generation, attempt, lastFailure, progress.stage),
    );
  });

  const establishConnection = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
  ) {
    return yield* driver.connect(entry, (progress) =>
      reportProgress(attempt, generation, lastFailure, progress),
    );
  });

  const waitForEstablishmentInterrupt = Effect.fnUntraced(function* () {
    for (;;) {
      const next = yield* Queue.take(signals);

      if (
        Predicate.isTagged(next, "DisconnectRequested") ||
        Predicate.isTagged(next, "RetryRequested")
      ) {
        return false;
      } else if (Predicate.isTagged(next, "NetworkChanged")) {
        if (next.network === "offline") {
          return false;
        }
      } else if (Predicate.isTagged(next, "Wakeup")) {
        if (next.reason === "application-active-reconnect") {
          return true;
        }
      }
    }
  });

  const monitorConnectedLease = Effect.fnUntraced(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    for (;;) {
      const next = yield* Queue.take(signals);

      if (
        Predicate.isTagged(next, "DisconnectRequested") ||
        Predicate.isTagged(next, "RetryRequested")
      ) {
        return false;
      } else if (Predicate.isTagged(next, "NetworkChanged")) {
        if (next.network === "offline") {
          return false;
        }
      } else if (Predicate.isTagged(next, "Wakeup")) {
        if (next.reason === "application-active-reconnect") {
          // Mobile operating systems commonly suspend sockets without
          // delivering a close event. A long background resume deliberately
          // replaces that lease and starts a fresh attempt without backoff.
          return true;
        }

        if (next.reason === "application-active" || next.reason === "application-active-probe") {
          const probe = yield* lease.session.probe.pipe(
            Effect.timeoutOrElse({
              duration:
                next.reason === "application-active-probe"
                  ? MOBILE_CONNECTION_PROBE_TIMEOUT
                  : CONNECTION_PROBE_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new ConnectionTransientError({
                    reason: "timeout",
                    detail: `${target.label} did not respond to a connection health check.`,
                  }),
                ),
            }),
            Effect.forkChild,
          );

          for (;;) {
            const probeEvent = yield* Effect.raceFirst(
              Fiber.await(probe).pipe(
                Effect.map((exit) => ({ _tag: "ProbeCompleted" as const, exit })),
              ),
              Queue.take(signals).pipe(
                Effect.map((signal) => ({ _tag: "Signal" as const, signal })),
              ),
            );

            if (Predicate.isTagged(probeEvent, "ProbeCompleted")) {
              if (Exit.isFailure(probeEvent.exit)) {
                yield* Ref.set(wakeProbeFailed, true);
              }

              yield* probeEvent.exit;
              break;
            }

            if (
              Predicate.isTagged(probeEvent.signal, "DisconnectRequested") ||
              Predicate.isTagged(probeEvent.signal, "RetryRequested")
            ) {
              yield* Fiber.interrupt(probe);

              return false;
            } else if (Predicate.isTagged(probeEvent.signal, "NetworkChanged")) {
              if (probeEvent.signal.network === "offline") {
                yield* Fiber.interrupt(probe);

                return false;
              }
            } else if (Predicate.isTagged(probeEvent.signal, "Wakeup")) {
              if (probeEvent.signal.reason === "application-active-reconnect") {
                yield* Fiber.interrupt(probe);

                return true;
              }
            }
          }
        }
      }
    }
  });

  const runAttempt = Effect.fnUntraced(function* (
    attempt: number,
    generation: number,
    lastFailure: ConnectionAttemptError | null,
  ) {
    yield* SubscriptionRef.set(prepared, Option.none());

    const establishment = yield* Effect.raceAllFirst([
      exitUnlessInterrupted(establishConnection(attempt, generation, lastFailure)).pipe(
        Effect.map((exit): EstablishmentEvent => Establishment.Completed({ exit })),
      ),
      waitForEstablishmentInterrupt().pipe(
        Effect.map((resetRetry): EstablishmentEvent => Establishment.Interrupted({ resetRetry })),
      ),
      Effect.sleep(CONNECTION_ESTABLISHMENT_TIMEOUT).pipe(
        Effect.as<EstablishmentEvent>(Establishment.TimedOut()),
      ),
    ]);

    if (isEstablishmentInterrupted(establishment)) {
      return Outcome.Interrupted({
        established: false,
        stable: false,
        resetRetry: establishment.resetRetry,
      }) satisfies AttemptOutcome;
    }

    if (isEstablishmentTimedOut(establishment)) {
      return Outcome.Failure({
        established: false,
        stable: false,
        failure: new ConnectionTransientError({
          reason: "timeout",
          detail: `${target.label} did not respond during connection setup.`,
        }),
      }) satisfies AttemptOutcome;
    }

    if (Exit.isFailure(establishment.exit)) {
      const isUnexpectedDefect =
        !Cause.hasInterruptsOnly(establishment.exit.cause) &&
        !establishment.exit.cause.reasons.some(Cause.isFailReason);

      const outcome = failureFromExit(target, establishment.exit, false, false);

      if (isUnexpectedDefect) {
        const defect = establishment.exit.cause.reasons.find(Cause.isDieReason)?.defect;
        yield* Effect.logError("Connection attempt failed with an unexpected defect.").pipe(
          Effect.annotateLogs({
            "environment.id": target.environmentId,
            "environment.label": target.label,
            "cause.reason_count": establishment.exit.cause.reasons.length,
            ...safeErrorLogAttributes(defect),
          }),
        );
      }

      return outcome;
    }

    const active = establishment.exit.value;
    const currentIntent = yield* Ref.get(intent);

    if (!currentIntent.desired || currentIntent.network === "offline") {
      return Outcome.Interrupted({
        established: false,
        stable: false,
        resetRetry: false,
      }) satisfies AttemptOutcome;
    }

    const connectedAt = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.set(prepared, Option.some(active.prepared));
    yield* SubscriptionRef.set(session, Option.some(active.session));
    yield* setState({
      desired: true,
      network: currentIntent.network,
      phase: "connected",
      stage: null,
      attempt,
      generation,
      lastFailure: null,
      retryAt: null,
    });

    const connectedExit = yield* Effect.raceFirst(
      active.session.closed,
      monitorConnectedLease(active),
    ).pipe(exitUnlessInterrupted);

    const connectedForMs = (yield* Clock.currentTimeMillis) - connectedAt;

    if (Exit.isSuccess(connectedExit)) {
      return Outcome.Interrupted({
        established: true,
        stable: connectedForMs >= BACKOFF_RESET_AFTER_MS,
        resetRetry: connectedExit.value,
      }) satisfies AttemptOutcome;
    }

    return failureFromExit(target, connectedExit, true, connectedForMs >= BACKOFF_RESET_AFTER_MS);
  }, Effect.ensuring(clearLease));

  const waitForRetrySignal = Effect.fnUntraced(function* (delayMs: number) {
    return yield* Effect.raceFirst(
      Effect.sleep(delayMs).pipe(Effect.as(false)),
      Effect.gen(function* () {
        for (;;) {
          const next = yield* Queue.take(signals);

          return Match.value(next).pipe(
            Match.tagsExhaustive({
              Wakeup: (next) => {
                return ConnectionWakeups.isApplicationActiveWakeup(next.reason);
              },
              ConnectRequested: () => {
                return false;
              },
              DisconnectRequested: () => {
                return false;
              },
              RetryRequested: () => {
                return false;
              },
              NetworkChanged: () => {
                return false;
              },
            }),
          );
        }
      }),
    );
  });

  const waitForSignal = Queue.take(signals).pipe(
    Effect.map(
      (next) =>
        Predicate.isTagged(next, "Wakeup") &&
        ConnectionWakeups.isApplicationActiveWakeup(next.reason),
    ),
  );

  const run = Effect.fnUntraced(function* () {
    let failureCount = 0;
    let generation = 0;
    let latestFailure: ConnectionAttemptError | null = null;

    const resetRetryLadder = () => {
      failureCount = 0;
    };

    for (;;) {
      if (yield* Ref.getAndSet(resetRetryState, false)) {
        failureCount = 0;
        latestFailure = null;
      }

      const currentIntent = yield* Ref.get(intent);

      if (!currentIntent.desired) {
        resetRetryLadder();
        latestFailure = null;
        yield* clearLease;
        yield* setState(availableState(currentIntent, generation));
        yield* waitForSignal;
        continue;
      }

      if (currentIntent.network === "offline") {
        yield* clearLease;
        yield* setState(offlineState(currentIntent, generation, failureCount + 1, latestFailure));
        const applicationActivated = yield* waitForSignal;

        if (applicationActivated) {
          resetRetryLadder();
        }

        continue;
      }

      const attempt = failureCount + 1;
      const nextGeneration = generation + 1;

      const outcome: AttemptOutcome = yield* Effect.scoped(
        runAttempt(attempt, nextGeneration, latestFailure),
      );

      // Consumed on every iteration so a stale marker can never leak into a
      // later, unrelated failure.
      const failedWakeProbe = yield* Ref.getAndSet(wakeProbeFailed, false);

      if (outcome.established) {
        generation = nextGeneration;

        if (outcome.stable) {
          resetRetryLadder();
          latestFailure = null;
        }
      }

      if (Predicate.isTagged(outcome, "Interrupted")) {
        if (outcome.resetRetry) {
          resetRetryLadder();
        }

        continue;
      }

      const error: ConnectionAttemptError = outcome.failure;
      latestFailure = error;

      if (Predicate.isTagged(error, "ConnectionBlockedError")) {
        const blockedIntent = yield* Ref.get(intent);
        yield* setState({
          desired: blockedIntent.desired,
          network: blockedIntent.network,
          phase: "blocked",
          stage: null,
          attempt,
          generation,
          lastFailure: error,
          retryAt: null,
        });
        const applicationActivated = yield* waitForSignal;

        if (applicationActivated) {
          resetRetryLadder();
        }

        continue;
      }

      if (failedWakeProbe) {
        // The wake probe found a dead transport while the user is returning to
        // the app, so reconnect immediately instead of sleeping the first
        // backoff rung. Only this first attempt skips the ladder; if it fails
        // too, normal backoff resumes.
        resetRetryLadder();
        yield* setState(connectingState(yield* Ref.get(intent), generation, 1, error));
        continue;
      }

      failureCount += 1;
      const delayMs = retryDelayMs(failureCount - 1);
      const failedIntent = yield* Ref.get(intent);
      yield* setState({
        desired: failedIntent.desired,
        network: failedIntent.network,
        phase: "backoff",
        stage: null,
        attempt,
        generation,
        lastFailure: error,
        retryAt: (yield* Clock.currentTimeMillis) + delayMs,
      });
      const applicationActivated = yield* waitForRetrySignal(delayMs);

      if (applicationActivated) {
        resetRetryLadder();
      }
    }
  });

  yield* connectivity.changes.pipe(
    Stream.runForEach((network) =>
      Ref.modify(intent, (current) =>
        current.network === network ? [false, current] : ([true, { ...current, network }] as const),
      ).pipe(
        Effect.flatMap((changed) =>
          changed ? signal(Signal.NetworkChanged({ network })) : Effect.void,
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* wakeups.changes.pipe(
    Stream.runForEach((reason) => signal(Signal.Wakeup({ reason }))),
    Effect.forkScoped,
  );
  yield* run().pipe(Effect.forkScoped);

  const connect = Ref.update(intent, (current) => ({
    ...current,
    desired: true,
  })).pipe(
    Effect.andThen(signal(Signal.ConnectRequested())),
    Effect.withSpan("EnvironmentSupervisor.connect"),
  );

  const disconnect = Ref.update(intent, (current) => ({
    ...current,
    desired: false,
  })).pipe(
    Effect.andThen(signal(Signal.DisconnectRequested())),
    Effect.withSpan("EnvironmentSupervisor.disconnect"),
  );

  // Retry is the user asking to connect now, so it also restores connection
  // intent: an available environment that is not connecting starts connecting.
  const retryNow = Ref.set(resetRetryState, true).pipe(
    Effect.andThen(Ref.update(intent, (current) => ({ ...current, desired: true }))),
    Effect.andThen(signal(Signal.RetryRequested())),
    Effect.withSpan("EnvironmentSupervisor.retryNow"),
  );

  // Automatic nudges read the intent a disconnect writes and never set it, so a
  // disconnect that lands at the same time is not undone.
  const retryIfDesired = Ref.get(intent).pipe(
    Effect.flatMap((current) =>
      current.desired
        ? Ref.set(resetRetryState, true).pipe(Effect.andThen(signal(Signal.RetryRequested())))
        : Effect.void,
    ),
    Effect.withSpan("EnvironmentSupervisor.retryIfDesired"),
  );

  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearLease)));

  return EnvironmentSupervisor.of({
    target,
    state,
    session,
    prepared,
    connect,
    disconnect,
    retryNow,
    retryIfDesired,
  });
});

export const layer = (
  entry: ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
): Layer.Layer<
  EnvironmentSupervisor,
  never,
  | Connectivity.Connectivity
  | ConnectionDriver.ConnectionDriver
  | ConnectionWakeups.ConnectionWakeups
> => Layer.effect(EnvironmentSupervisor, make(entry, options));

function isEstablishmentInterrupted(
  value: EstablishmentEvent,
): value is Extract<EstablishmentEvent, { readonly _tag: "Interrupted" }> {
  return Predicate.isTagged(value, "Interrupted");
}

function isEstablishmentTimedOut(
  value: EstablishmentEvent,
): value is Extract<EstablishmentEvent, { readonly _tag: "TimedOut" }> {
  return Predicate.isTagged(value, "TimedOut");
}
