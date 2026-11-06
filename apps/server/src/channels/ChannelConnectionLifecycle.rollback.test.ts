import { BotId, CommandId, type ChannelBinding } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { createChannelLinkCode } from "./ChannelAccess.ts";
import { commitStartedChannel } from "./ChannelConnectionLifecycle.ts";
import { memoryChannelFollowStore } from "./ChannelFollowStore.ts";
import { keyedLock, withChannelOperation } from "./ChannelOperations.ts";
import type {
  ChannelRuntimeContext,
  ChannelRuntimeEntry,
  PendingChannelLinkCode,
} from "./ChannelRuntimeTypes.ts";
import { runtimeKey } from "./ChannelSecrets.ts";
import { BOT_ID, NOW, makeBot, makeHarness } from "./testUtils/channelRuntime.ts";

const transport = (): ChannelRuntimeEntry => ({ post: () => Effect.void, shutdown: Effect.void });

const pending: PendingChannelLinkCode = {
  botId: BotId.make(BOT_ID),
  provider: "slack",
  connectionId: undefined,
  expiresAt: Number.MAX_SAFE_INTEGER,
};

const binding: ChannelBinding = {
  botId: BotId.make(BOT_ID),
  provider: "slack",
  status: "connected",
  externalIdentity: "@scout",
  connectedAt: NOW,
  sentMessageIds: [],
};

describe("commitStartedChannel", () => {
  it.effect("puts back the link codes of a transport a failed reconnect restores", () =>
    Effect.gen(function* () {
      // The first binding write this commit makes fails, so it rolls back.
      const harness = makeHarness({
        failBotUpdate: (index) => (index === 1 ? new Error("binding write failed") : undefined),
      });

      const previous = transport();
      const key = runtimeKey(BotId.make(BOT_ID), "slack");

      const ctx: ChannelRuntimeContext = {
        deps: harness.dependencies,
        runtimes: new Map([[key, previous]]),
        statuses: new WeakMap(),
        withLock: keyedLock(),
        runSdkCallback: yield* FiberSet.makeRuntimePromise(),
        transportScope: yield* Scope.make(),
        connecting: new Set(),
        follows: memoryChannelFollowStore(),
        linkCodes: new Map([["ABCD2345", pending]]),
        closed: false,
      };

      const committed = yield* Effect.exit(
        commitStartedChannel(ctx, { binding, runtime: transport() }),
      );

      expect(Exit.isFailure(committed)).toBe(true);

      expect(ctx.runtimes.get(key)).toBe(previous);
      expect(ctx.linkCodes.get("ABCD2345")).toBe(pending);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a code made while a reconnect was saving when that reconnect rolls back", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ bots: [makeBot(BOT_ID, { channelBindings: [binding] })] });
      const saving = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const previous = transport();
      const key = runtimeKey(BotId.make(BOT_ID), "slack");

      const ctx: ChannelRuntimeContext = {
        deps: {
          ...harness.dependencies,
          // The reconnect pauses while saving its secret, then the save fails.
          secretStore: {
            ...harness.dependencies.secretStore,
            set: () =>
              Deferred.succeed(saving, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die(new Error("secret write failed"))),
              ),
          },
        },
        runtimes: new Map([[key, previous]]),
        statuses: new WeakMap(),
        withLock: keyedLock(),
        runSdkCallback: yield* FiberSet.makeRuntimePromise(),
        transportScope: yield* Scope.make(),
        connecting: new Set(),
        follows: memoryChannelFollowStore(),
        linkCodes: new Map([["ABCD2345", pending]]),
        closed: false,
      };

      // A reconnect holds the provider's channel operation for its whole commit.
      const reconnect = yield* withChannelOperation(
        ctx,
        "slack",
      )(
        commitStartedChannel(
          ctx,
          { binding, runtime: transport() },
          { provider: "slack", botToken: "xoxb-new", appToken: "xapp-new" },
        ),
      ).pipe(Effect.exit, Effect.forkChild);

      yield* Deferred.await(saving);

      const created = yield* createChannelLinkCode(ctx, {
        type: "channel.link-code.create",
        commandId: CommandId.make("link-during-reconnect"),
        botId: BotId.make(BOT_ID),
        provider: "slack",
        code: "WXYZ6789",
      }).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      expect(created.pollUnsafe()).toBeUndefined();

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(reconnect);
      yield* Fiber.join(created);

      expect(ctx.runtimes.get(key)).toBe(previous);
      expect([...ctx.linkCodes.keys()]).toEqual(["WXYZ6789"]);
    }).pipe(Effect.scoped),
  );
});
