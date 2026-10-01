import { BOT_ID, PROJECT_ID, makeHarness, telegramConnect } from "./testUtils/channelRuntime.ts";
import { type ChannelBinding } from "@akeru/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import {
  ChannelPostRejectedError,
  ChannelRuntime,
  channelBindingsForRuntime as channelBindingsWith,
  makeKeyedLock,
  type ChannelRuntimeDependencies,
} from "./ChannelRuntime.ts";
describe("channel runtime", () => {
  it.effect("serializes work per key in FIFO order while different keys overlap", () =>
    Effect.gen(function* () {
      const withLock = makeKeyedLock();
      const events: string[] = [];
      const releaseFirst = yield* Deferred.make<void>();
      const firstStarted = yield* Deferred.make<void>();
      const first = yield* withLock("same")(
        Effect.gen(function* () {
          events.push("same:start");
          yield* Deferred.succeed(firstStarted, undefined);
          yield* Deferred.await(releaseFirst);
          events.push("same:end");
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      const second = yield* withLock("same")(
        Effect.sync(() => void events.push("same:second")),
      ).pipe(Effect.forkChild);
      const third = yield* withLock("same")(Effect.sync(() => void events.push("same:third"))).pipe(
        Effect.forkChild,
      );
      yield* withLock("other")(Effect.sync(() => void events.push("other")));
      expect(events).toEqual(["same:start", "other"]);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(third);
      expect(events).toEqual(["same:start", "other", "same:end", "same:second", "same:third"]);
    }),
  );

  it.effect("lets a queued caller be interrupted without blocking later callers", () =>
    Effect.gen(function* () {
      const withLock = makeKeyedLock();
      const events: string[] = [];
      const releaseFirst = yield* Deferred.make<void>();
      const firstStarted = yield* Deferred.make<void>();
      const first = yield* withLock("same")(
        Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.andThen(Effect.sync(() => void events.push("first"))),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      const abandoned = yield* withLock("same")(
        Effect.sync(() => void events.push("abandoned")),
      ).pipe(Effect.forkChild);
      const last = yield* withLock("same")(Effect.sync(() => void events.push("last"))).pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      expect(abandoned.pollUnsafe()).toBeUndefined();
      // Interrupting must not wait for the key the first caller still holds.
      yield* Fiber.interrupt(abandoned);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(last);
      expect(events).toEqual(["first", "last"]);
    }),
  );

  it("asks to reconnect a not-live WhatsApp binding whose transport stopped", () => {
    const binding: ChannelBinding = {
      status: "not-live",
      botId: BOT_ID,
      provider: "whatsapp",
      projectId: PROJECT_ID,
      externalIdentity: null,
      connectedAt: null,
      sentMessageIds: [],
    };
    expect(channelBindingsWith([binding], () => false)[0]?.status).toBe("needs-reconnect");
    expect(channelBindingsWith([binding], () => true)[0]?.status).toBe("not-live");
  });

  it("keeps ChannelPostRejectedError typed and message-safe", () => {
    const error = new ChannelPostRejectedError({ message: "rejected" });
    expect(error._tag).toBe("ChannelPostRejectedError");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("rejected");
  });

  it.effect("shuts down active transports when the service scope closes", () =>
    Effect.gen(function* () {
      const shutdown = vi.fn(async () => undefined);
      const harness = makeHarness({ shutdown });
      yield* Effect.gen(function* () {
        const runtime = yield* ChannelRuntime;
        yield* runtime.connect(telegramConnect(BOT_ID));
        expect(shutdown).not.toHaveBeenCalled();
      }).pipe(Effect.provide(ChannelRuntime.layerWith(harness.dependencies)));
      expect(shutdown).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("keeps independent runtime scopes isolated", () =>
    Effect.gen(function* () {
      const firstShutdown = vi.fn(async () => undefined);
      const secondShutdown = vi.fn(async () => undefined);
      const first = makeHarness({ shutdown: firstShutdown });
      const second = makeHarness({ shutdown: secondShutdown });
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const build = (dependencies: ChannelRuntimeDependencies, scope: Scope.Scope) =>
        Layer.buildWithScope(ChannelRuntime.layerWith(dependencies), scope).pipe(
          Effect.map((context) => Context.get(context, ChannelRuntime)),
        );
      const firstRuntime = yield* build(first.dependencies, firstScope);
      const secondRuntime = yield* build(second.dependencies, secondScope);
      yield* firstRuntime.connect(telegramConnect(BOT_ID));
      yield* secondRuntime.connect(telegramConnect(BOT_ID));

      yield* Scope.close(firstScope, Exit.void);
      expect(firstShutdown).toHaveBeenCalledTimes(1);
      expect(secondShutdown).not.toHaveBeenCalled();
      expect(
        secondRuntime.channelBindingsForRuntime(second.readModel().bots[0]!.channelBindings),
      ).toMatchObject([{ status: "connected" }]);

      yield* Scope.close(secondScope, Exit.void);
      expect(secondShutdown).toHaveBeenCalledTimes(1);
    }),
  );
});
