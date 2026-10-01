import {
  expectFailureMessage,
  expectProviderFailure,
  connectChannel,
  disconnectChannel,
  channelBindingsForRuntime,
  makeGatewayListener,
  startTestGateway,
  BOT_ID,
  PROJECT_ID,
  makeHarness,
  slackConnect,
  discordConnect,
  externalAdapters,
} from "./testUtils/channelRuntime.ts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Duration from "effect/Duration";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { CHANNEL_GATEWAY_RENEWAL_INTERVAL, startRenewingGateway } from "./ChannelRuntime.ts";

describe("channel runtime", () => {
  it.effect("exposes gateway failure in runtime channel health", () =>
    Effect.gen(function* () {
      const failed = Promise.withResolvers<void>();

      const gateway = yield* startTestGateway(async (waitUntil) => {
        waitUntil(failed.promise);

        return new Response(null, { status: 200 });
      }, "Test gateway");

      const harness = makeHarness({
        startTransport: async () => ({
          externalIdentity: "test",
          runtime: {
            post: async () => {},
            shutdown: gateway.shutdown,
            isHealthy: gateway.isHealthy,
          },
        }),
      });

      yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));
      const bindings = harness.readModel().bots[0]!.channelBindings;
      expect(channelBindingsForRuntime(bindings)[0]?.status).toBe("connected");
      failed.reject(new Error("Gateway disconnected"));
      yield* gateway.settled;
      expect(channelBindingsForRuntime(bindings)[0]?.status).toBe("needs-reconnect");
    }),
  );

  it.effect("shuts down an adapter when chat initialization fails", () =>
    Effect.gen(function* () {
      externalAdapters.slackInitializationFails = true;
      const harness = makeHarness({ startTransport: null });

      yield* expectProviderFailure(
        connectChannel(harness.dependencies, slackConnect(BOT_ID)),
        "Socket startup failed",
      );

      expect(externalAdapters.slackDisconnects).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
      expect(harness.secrets.size).toBe(0);
    }),
  );

  it.effect("rejects Slack credentials that cannot resolve the bot identity", () =>
    Effect.gen(function* () {
      externalAdapters.slackIdentityAvailable = false;
      const harness = makeHarness({ startTransport: null });

      yield* expectFailureMessage(
        connectChannel(harness.dependencies, slackConnect(BOT_ID)),
        "Slack bot credentials are invalid",
      );
      expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
    }),
  );

  it.effect("owns and aborts renewable Gateway listeners", () =>
    Effect.gen(function* () {
      const listener = yield* makeGatewayListener();
      const gateway = yield* startRenewingGateway(listener.start, "Test gateway");
      const first = yield* Queue.take(listener.starts);

      expect(first.durationMs).toBe(Duration.toMillis(CHANNEL_GATEWAY_RENEWAL_INTERVAL));
      expect(first.signal.aborted).toBe(false);
      yield* gateway.shutdown;
      expect(first.signal.aborted).toBe(true);
      expect(gateway.isHealthy()).toBe(false);
    }),
  );

  it.effect("renews the gateway listener at each renewal deadline", () =>
    Effect.gen(function* () {
      const listener = yield* makeGatewayListener();
      const scope = yield* Scope.make();

      const gateway = yield* startRenewingGateway(listener.start, "Test gateway").pipe(
        Scope.provide(scope),
      );

      const first = yield* Queue.take(listener.starts);

      yield* TestClock.adjust(
        Duration.subtract(CHANNEL_GATEWAY_RENEWAL_INTERVAL, Duration.millis(1)),
      );
      expect(yield* Queue.size(listener.starts)).toBe(0);
      yield* TestClock.adjust(Duration.millis(1));
      const second = yield* Queue.take(listener.starts);
      // The listener that outlived its deadline stops before the next one starts.
      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(false);
      expect(gateway.isHealthy()).toBe(true);
      yield* TestClock.adjust(CHANNEL_GATEWAY_RENEWAL_INTERVAL);
      yield* Queue.take(listener.starts);
      expect(gateway.isHealthy()).toBe(true);

      // Closing the owning scope stops renewal.
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(Duration.times(CHANNEL_GATEWAY_RENEWAL_INTERVAL, 2));
      expect(yield* Queue.size(listener.starts)).toBe(0);
    }),
  );

  it.effect("waits for gateway cleanup before shutdown completes", () =>
    Effect.gen(function* () {
      const cleanup = Promise.withResolvers<void>();
      const listener = yield* makeGatewayListener(cleanup.promise);
      const gateway = yield* startRenewingGateway(listener.start, "Test gateway");
      const { signal } = yield* Queue.take(listener.starts);
      const aborted = yield* Deferred.make<void>();
      signal.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Effect.void), {
        once: true,
      });

      const shutdown = yield* gateway.shutdown.pipe(Effect.forkChild);
      yield* Deferred.await(aborted);
      expect(shutdown.pollUnsafe()).toBeUndefined();
      expect(gateway.isHealthy()).toBe(false);
      cleanup.resolve();
      yield* Fiber.join(shutdown);
    }),
  );

  it.effect("fails when the first gateway listener cannot launch", () =>
    Effect.gen(function* () {
      let starts = 0;

      const exit = yield* startRenewingGateway(async () => {
        starts += 1;

        return new Response(null, { status: 503 });
      }, "Test gateway").pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      yield* TestClock.adjust(Duration.times(CHANNEL_GATEWAY_RENEWAL_INTERVAL, 2));
      expect(starts).toBe(1);
    }),
  );

  it.effect("marks an early gateway exit unhealthy instead of restarting it", () =>
    Effect.gen(function* () {
      let starts = 0;

      const gateway = yield* startRenewingGateway(async (waitUntil) => {
        starts += 1;
        waitUntil(Promise.resolve());

        return new Response(null, { status: 200 });
      }, "Test gateway");

      yield* gateway.settled;
      expect(gateway.isHealthy()).toBe(false);
      yield* TestClock.adjust(Duration.times(CHANNEL_GATEWAY_RENEWAL_INTERVAL, 2));
      expect(starts).toBe(1);
      yield* gateway.shutdown;
    }),
  );

  it.effect("shuts down Discord when credential validation fails", () =>
    Effect.gen(function* () {
      externalAdapters.discordIdentityFails = true;
      const harness = makeHarness({ startTransport: null });

      yield* expectProviderFailure(
        connectChannel(harness.dependencies, discordConnect(BOT_ID)),
        "Discord identity failed",
      );

      expect(externalAdapters.discordDisconnects).toBe(1);
      expect(externalAdapters.discordGatewayStarts).toBe(0);
      expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
      expect(harness.secrets.size).toBe(0);
    }),
  );

  it.effect("starts and stops the supervised Discord Gateway", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ startTransport: null });
      yield* connectChannel(harness.dependencies, discordConnect(BOT_ID));

      expect(externalAdapters.discordGatewayStarts).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings[0]).toMatchObject({
        projectId: PROJECT_ID,
        provider: "discord",
        status: "connected",
      });

      yield* disconnectChannel(harness.dependencies, BOT_ID, "discord");
      expect(harness.readModel().bots[0]?.channelBindings[0]?.status).toBe("disconnected");
    }),
  );
});
