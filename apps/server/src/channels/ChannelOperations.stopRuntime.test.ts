import { BotId, ChannelConnectionId } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Scope from "effect/Scope";
import { describe, expect } from "vite-plus/test";

import { ChannelRuntimeError } from "./ChannelErrors.ts";
import { memoryChannelFollowStore } from "./ChannelFollowStore.ts";
import { keyedLock, stopRuntime } from "./ChannelOperations.ts";
import type {
  ChannelRuntimeContext,
  ChannelRuntimeEntry,
  PendingChannelLinkCode,
} from "./ChannelRuntimeTypes.ts";
import { runtimeKey } from "./ChannelSecrets.ts";
import { makeHarness } from "./testUtils/channelRuntime.ts";

const botId = BotId.make("bot-stop");

const pending: PendingChannelLinkCode = {
  botId,
  provider: "slack",
  connectionId: ChannelConnectionId.make("connection-stop"),
  expiresAt: Number.MAX_SAFE_INTEGER,
};

/** A channel context holding one running Slack transport and one pending link code. */
const contextWith = (runtime: ChannelRuntimeEntry) =>
  Effect.gen(function* () {
    const ctx: ChannelRuntimeContext = {
      deps: makeHarness({}).dependencies,
      runtimes: new Map([[runtimeKey(botId, "slack"), runtime]]),
      statuses: new WeakMap(),
      withLock: keyedLock(),
      runSdkCallback: yield* FiberSet.makeRuntimePromise(),
      transportScope: yield* Scope.make(),
      connecting: new Set(),
      follows: memoryChannelFollowStore(),
      linkCodes: new Map([["ABCD2345", pending]]),
      closed: false,
    };

    return ctx;
  });

const transport = (shutdown: ChannelRuntimeEntry["shutdown"]): ChannelRuntimeEntry => ({
  post: () => Effect.void,
  shutdown,
});

describe("stopRuntime", () => {
  it.effect("keeps a kept transport's link codes when it fails to stop", () =>
    Effect.gen(function* () {
      const runtime = transport(Effect.fail(new ChannelRuntimeError({ message: "stuck" })));
      const ctx = yield* contextWith(runtime);

      yield* stopRuntime(ctx, botId, "slack", { keepOnFailure: true }).pipe(Effect.flip);

      expect(ctx.runtimes.get(runtimeKey(botId, "slack"))).toBe(runtime);
      expect(ctx.linkCodes.get("ABCD2345")).toBe(pending);
    }).pipe(Effect.scoped),
  );

  it.effect("drops the link codes when the transport stops", () =>
    Effect.gen(function* () {
      const ctx = yield* contextWith(transport(Effect.void));

      yield* stopRuntime(ctx, botId, "slack", { keepOnFailure: true });

      expect(ctx.runtimes.size).toBe(0);
      expect(ctx.linkCodes.size).toBe(0);
    }).pipe(Effect.scoped),
  );
});
