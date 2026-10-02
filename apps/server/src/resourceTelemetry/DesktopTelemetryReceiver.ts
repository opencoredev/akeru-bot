import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  type DesktopHostTelemetryMessage as DesktopHostTelemetryMessageValue,
  type DesktopHostTelemetrySnapshot,
  DesktopTelemetryControlMessage,
} from "@akeru/contracts";
import { resolveServerBackgroundActivitySettings } from "@akeru/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";
import {
  INITIAL_SAMPLE_DEADLINE_MS,
  DEFAULT_HOST_POWER_ACTIVE_INTERVAL_MS,
  DEFAULT_HOST_POWER_IDLE_INTERVAL_MS,
  isDesktopTelemetryContactStale,
  resolveDesktopTelemetrySnapshotStaleAfterMs,
  initialDesktopTelemetryContactAt,
  recordDesktopTelemetrySampleHealth,
} from "./DesktopTelemetryHealth.ts";
import {
  DesktopTelemetryDescriptorUnavailable,
  DesktopTelemetryProtocolMismatch,
  DesktopTelemetryDecodeFailed,
  DesktopTelemetryStreamFailed,
  DesktopTelemetryStreamClosed,
  DesktopTelemetryStale,
  type DesktopTelemetryReceiverError,
  DesktopTelemetryControlFailed,
  type DesktopTelemetryControlError,
  type DesktopTelemetryReceiverHealth,
} from "./DesktopTelemetryTypes.ts";
import {
  decodeMessage,
  encodeControlMessage,
  normalizeReceiverError,
  messageVersion,
  writeAllToFileDescriptor,
  openDesktopTelemetryReadable,
} from "./DesktopTelemetryTransport.ts";

const STALE_CHECK_INTERVAL = Duration.seconds(30);

export class DesktopTelemetryReceiver extends Context.Service<
  DesktopTelemetryReceiver,
  {
    readonly latest: Effect.Effect<Option.Option<DesktopHostTelemetrySnapshot>>;
    readonly changes: Stream.Stream<DesktopHostTelemetrySnapshot>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: Option.Option<DesktopHostTelemetrySnapshot>;
        readonly changes: Stream.Stream<DesktopHostTelemetrySnapshot>;
      },
      never,
      Scope.Scope
    >;
    readonly health: Effect.Effect<DesktopTelemetryReceiverHealth>;
    readonly subscribeHealth: Effect.Effect<
      {
        readonly latest: DesktopTelemetryReceiverHealth;
        readonly changes: Stream.Stream<DesktopTelemetryReceiverHealth>;
      },
      never,
      Scope.Scope
    >;
    readonly setDiagnosticsDemand: (
      enabled: boolean,
    ) => Effect.Effect<void, DesktopTelemetryControlError>;
  }
>()("akeru-bot/resourceTelemetry/DesktopTelemetryReceiver") {}

export const make = Effect.fn("resourceTelemetry.desktopTelemetryReceiver.make")(function* () {
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const latest = yield* Ref.make(Option.none<DesktopHostTelemetrySnapshot>());
  const receiverStartedAt = yield* DateTime.now;

  const lastContactAtMs = yield* Ref.make(
    initialDesktopTelemetryContactAt(
      config.desktopTelemetryFd,
      DateTime.toEpochMillis(receiverStartedAt),
    ),
  );

  const snapshotStaleAfterMs = yield* Ref.make(
    resolveDesktopTelemetrySnapshotStaleAfterMs(
      DEFAULT_HOST_POWER_ACTIVE_INTERVAL_MS,
      DEFAULT_HOST_POWER_IDLE_INTERVAL_MS,
    ),
  );

  const changes = yield* PubSub.sliding<DesktopHostTelemetrySnapshot>(8);
  const healthChanges = yield* PubSub.sliding<DesktopTelemetryReceiverHealth>(4);
  const controlMutex = yield* Semaphore.make(1);
  const snapshotMutex = yield* Semaphore.make(1);

  const health = yield* Ref.make<DesktopTelemetryReceiverHealth>({
    status: config.desktopTelemetryFd === undefined ? "unavailable" : "starting",
    lastSampleAt: Option.none(),
    lastError:
      config.desktopTelemetryFd === undefined
        ? Option.some(
            new DesktopTelemetryDescriptorUnavailable({
              mode: config.mode,
            }).message,
          )
        : Option.none(),
  });

  const updateHealth = (
    update: (current: DesktopTelemetryReceiverHealth) => DesktopTelemetryReceiverHealth,
  ) =>
    Ref.modify(health, (current) => {
      const next = update(current);

      return [next, next];
    }).pipe(
      Effect.flatMap((next) => PubSub.publish(healthChanges, next)),
      Effect.asVoid,
    );

  const updateSampleHealth = (sampledAt: DateTime.Utc) =>
    recordDesktopTelemetrySampleHealth(health, healthChanges, sampledAt);

  const sendControlMessage = (message: DesktopTelemetryControlMessage) =>
    controlMutex.withPermits(1)(
      Effect.gen(function* () {
        const fd = config.desktopTelemetryControlFd;

        if (fd === undefined) return;

        const encoded = yield* encodeControlMessage(message).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopTelemetryControlFailed({
                fd,
                operation: "encode",
                cause,
              }),
          ),
        );

        yield* writeAllToFileDescriptor(fd, Buffer.from(`${encoded}\n`)).pipe(
          Effect.tapError((error) =>
            updateHealth((current) => ({
              ...current,
              status: "degraded",
              lastError: Option.some(error.message),
            })),
          ),
        );
      }),
    );

  const setDiagnosticsDemand: DesktopTelemetryReceiver["Service"]["setDiagnosticsDemand"] = (
    enabled,
  ) =>
    sendControlMessage({
      version: 1,
      type: "setDiagnosticsDemand",
      enabled,
    });

  const sendHostPowerIntervals = (
    settings: Parameters<typeof resolveServerBackgroundActivitySettings>[0],
  ) => {
    const resolved = resolveServerBackgroundActivitySettings(settings);

    const activeIntervalMs = Math.max(
      1,
      Math.round(Duration.toMillis(resolved.hostPowerMonitorActiveInterval)),
    );

    const idleIntervalMs = Math.max(
      1,
      Math.round(Duration.toMillis(resolved.hostPowerMonitorIdleInterval)),
    );

    return sendControlMessage({
      version: 1,
      type: "setHostPowerIntervals",
      activeIntervalMs,
      idleIntervalMs,
    }).pipe(
      Effect.andThen(
        Ref.set(
          snapshotStaleAfterMs,
          resolveDesktopTelemetrySnapshotStaleAfterMs(activeIntervalMs, idleIntervalMs),
        ),
      ),
    );
  };

  if (config.desktopTelemetryControlFd !== undefined) {
    const settingsChanges = yield* serverSettings.subscribeChanges;
    const settings = yield* serverSettings.getSettings;
    yield* sendHostPowerIntervals(settings).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to configure desktop host-power intervals", {
          cause: String(cause),
        }),
      ),
    );
    yield* settingsChanges.pipe(
      Stream.runForEach((settings) =>
        sendHostPowerIntervals(settings).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to update desktop host-power intervals", {
              cause: String(cause),
            }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }

  if (config.desktopTelemetryFd !== undefined) {
    const fd = config.desktopTelemetryFd;

    const readable = yield* Effect.acquireRelease(
      Effect.try({
        try: () => openDesktopTelemetryReadable(fd),
        catch: (cause) => new DesktopTelemetryStreamFailed({ fd, cause }),
      }),
      (stream) =>
        Effect.sync(() => {
          stream.destroy();
        }),
    );

    const messages: Stream.Stream<DesktopHostTelemetryMessageValue, DesktopTelemetryReceiverError> =
      NodeStream.fromReadable<Uint8Array, DesktopTelemetryStreamFailed>({
        evaluate: () => readable,
        closeOnDone: true,
        onError: (cause) => new DesktopTelemetryStreamFailed({ fd, cause }),
      }).pipe(
        Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
        Stream.mapEffect(
          (
            value,
          ): Effect.Effect<
            DesktopHostTelemetryMessageValue,
            DesktopTelemetryProtocolMismatch | DesktopTelemetryDecodeFailed
          > => {
            const version = messageVersion(value);

            if (version !== undefined && version !== 1) {
              return Effect.fail(
                new DesktopTelemetryProtocolMismatch({
                  expectedVersion: 1,
                  receivedVersion: version,
                }),
              );
            }

            return decodeMessage(value).pipe(
              Effect.mapError((cause) => new DesktopTelemetryDecodeFailed({ cause })),
            );
          },
        ),
        Stream.mapError(normalizeReceiverError),
      );

    yield* messages.pipe(
      Stream.runForEach((message) => {
        const recordContact = DateTime.now.pipe(
          Effect.flatMap((now) =>
            Ref.set(lastContactAtMs, Option.some(DateTime.toEpochMillis(now))),
          ),
        );

        if (message.type === "desktopTelemetryHello") {
          return recordContact.pipe(
            Effect.andThen(
              updateHealth(
                (current): DesktopTelemetryReceiverHealth => ({
                  ...current,
                  status: "healthy",
                  lastError: Option.none(),
                }),
              ),
            ),
          );
        }

        const sampledAt = DateTime.makeUnsafe(message.sampledAtUnixMs);

        return snapshotMutex.withPermits(1)(
          recordContact.pipe(
            Effect.andThen(Ref.set(latest, Option.some(message))),
            Effect.andThen(updateSampleHealth(sampledAt)),
            Effect.andThen(PubSub.publish(changes, message)),
            Effect.asVoid,
          ),
        );
      }),
      Effect.andThen(
        updateHealth(
          (current): DesktopTelemetryReceiverHealth => ({
            ...current,
            status: "stopped",
            lastError: Option.some(new DesktopTelemetryStreamClosed({ fd }).message),
          }),
        ),
      ),
      Effect.catch((error) =>
        updateHealth(
          (current): DesktopTelemetryReceiverHealth => ({
            ...current,
            status: "degraded",
            lastError: Option.some(error.message),
          }),
        ),
      ),
      Effect.forkScoped,
    );

    yield* Effect.forever(
      Effect.sleep(STALE_CHECK_INTERVAL).pipe(
        Effect.andThen(
          snapshotMutex.withPermits(1)(
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const nowMs = DateTime.toEpochMillis(now);
              const staleAfterMs = yield* Ref.get(snapshotStaleAfterMs);

              const staleSnapshot = yield* Ref.modify(latest, (current) => {
                if (
                  Option.isNone(current) ||
                  current.value.power.stale ||
                  nowMs - current.value.sampledAtUnixMs < staleAfterMs
                ) {
                  return [Option.none<DesktopHostTelemetrySnapshot>(), current] as const;
                }

                const stale: DesktopHostTelemetrySnapshot = {
                  ...current.value,
                  power: { ...current.value.power, stale: true },
                };

                return [Option.some(stale), Option.some(stale)] as const;
              });

              if (Option.isNone(staleSnapshot)) {
                const lastContact = yield* Ref.get(lastContactAtMs);

                if (!isDesktopTelemetryContactStale(lastContact, nowMs)) return;

                const staleMessage = new DesktopTelemetryStale({
                  fd,
                  staleAfterMs: INITIAL_SAMPLE_DEADLINE_MS,
                }).message;

                const changed = yield* Ref.modify(health, (current) => {
                  if (
                    current.status === "stopped" ||
                    Option.isSome(current.lastSampleAt) ||
                    (current.status === "degraded" &&
                      Option.contains(current.lastError, staleMessage))
                  ) {
                    return [Option.none<DesktopTelemetryReceiverHealth>(), current] as const;
                  }

                  const next: DesktopTelemetryReceiverHealth = {
                    ...current,
                    status: "degraded",
                    lastError: Option.some(staleMessage),
                  };

                  return [Option.some(next), next] as const;
                });

                if (Option.isSome(changed)) {
                  yield* PubSub.publish(healthChanges, changed.value);
                }

                return;
              }

              yield* updateHealth((currentHealth) => ({
                ...currentHealth,
                status: currentHealth.status === "stopped" ? "stopped" : "degraded",
                lastError:
                  currentHealth.status === "stopped"
                    ? currentHealth.lastError
                    : Option.some(new DesktopTelemetryStale({ fd, staleAfterMs }).message),
              }));
              yield* PubSub.publish(changes, staleSnapshot.value);
            }),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped);
  }

  return DesktopTelemetryReceiver.of({
    latest: Ref.get(latest),
    changes: Stream.fromPubSub(changes),
    subscribe: snapshotMutex.withPermits(1)(
      Effect.gen(function* () {
        const initial = yield* Ref.get(latest);
        const subscription = yield* PubSub.subscribe(changes);

        return {
          latest: initial,
          changes: Stream.fromSubscription(subscription),
        };
      }),
    ),
    health: Ref.get(health),
    subscribeHealth: subscribeBeforeSnapshotWithoutMutex(healthChanges, Ref.get(health)),
    setDiagnosticsDemand,
  });
});

export const layer = Layer.effect(DesktopTelemetryReceiver, make());

export const layerTest = (
  overrides: Partial<DesktopTelemetryReceiver["Service"]> = {},
): Layer.Layer<DesktopTelemetryReceiver> => {
  const latest = overrides.latest ?? Effect.succeedNone;
  const changes = overrides.changes ?? Stream.empty;

  const health =
    overrides.health ??
    Effect.succeed({
      status: "unavailable" as const,
      lastSampleAt: Option.none<DateTime.Utc>(),
      lastError: Option.some("Desktop telemetry test implementation is unavailable."),
    });

  return Layer.succeed(
    DesktopTelemetryReceiver,
    DesktopTelemetryReceiver.of({
      latest,
      changes,
      subscribe:
        overrides.subscribe ??
        latest.pipe(
          Effect.map((initial) => ({
            latest: initial,
            changes,
          })),
        ),
      health,
      subscribeHealth:
        overrides.subscribeHealth ??
        health.pipe(
          Effect.map((initial) => ({
            latest: initial,
            changes: Stream.empty,
          })),
        ),
      setDiagnosticsDemand: () => Effect.void,
      ...overrides,
    }),
  );
};

export { DesktopTelemetryDescriptorUnavailable } from "./DesktopTelemetryTypes.ts";

export { DesktopTelemetryProtocolMismatch } from "./DesktopTelemetryTypes.ts";

export { DesktopTelemetryDecodeFailed } from "./DesktopTelemetryTypes.ts";

export { DesktopTelemetryStreamFailed } from "./DesktopTelemetryTypes.ts";

export { DesktopTelemetryStreamClosed } from "./DesktopTelemetryTypes.ts";

export { DesktopTelemetryStale } from "./DesktopTelemetryTypes.ts";

export type { DesktopTelemetryReceiverError } from "./DesktopTelemetryTypes.ts";

export { DesktopTelemetryControlFailed } from "./DesktopTelemetryTypes.ts";

export { DesktopTelemetryControlStalled } from "./DesktopTelemetryTypes.ts";

export type { DesktopTelemetryControlError } from "./DesktopTelemetryTypes.ts";

export type { DesktopTelemetryReceiverHealth } from "./DesktopTelemetryTypes.ts";

export { isDesktopTelemetryContactStale } from "./DesktopTelemetryHealth.ts";

export { resolveDesktopTelemetrySnapshotStaleAfterMs } from "./DesktopTelemetryHealth.ts";

export { initialDesktopTelemetryContactAt } from "./DesktopTelemetryHealth.ts";

export { recordDesktopTelemetrySampleHealth } from "./DesktopTelemetryHealth.ts";

export { writeAllToFileDescriptor } from "./DesktopTelemetryTransport.ts";

export { requireDesktopTelemetryWriteProgress } from "./DesktopTelemetryTransport.ts";

export { openDesktopTelemetryReadable } from "./DesktopTelemetryTransport.ts";
