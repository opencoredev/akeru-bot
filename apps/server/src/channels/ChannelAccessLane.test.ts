import {
  BOT_ID,
  NOW,
  PROJECT_ID,
  connectChannel,
  detachChannelConnection,
  makeHarness,
  makeMemorySecretStore,
  runWith,
  slackConnect,
} from "./testUtils/channelRuntime.ts";
import { CommandId } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect } from "vite-plus/test";
import { CHANNEL_LINK_INVALID } from "./ChannelAccess.ts";
import { type ChannelFollowStoreShape } from "./ChannelFollowStore.ts";
import {
  type ChannelGateInput,
  type ChannelSenderMembership,
  type ChannelTransportContext,
} from "./ChannelRuntimeTypes.ts";

const THREAD = "slack:C1:1710000000.000100";

const owner = { provider: "slack" as const, workspaceId: "T-HOME", userId: "U-LEO", linkedAt: NOW };

const message = (
  kind: ChannelGateInput["kind"],
  externalMessageId: string,
  text: string,
  verifiedWorkspace: () => Promise<ChannelSenderMembership> = async () => ({
    kind: "member",
    workspaceId: "T-HOME",
  }),
  userId = "U-LEO",
): ChannelGateInput => ({
  kind,
  externalThreadId: kind === "direct" ? "slack:D1:" : THREAD,
  externalMessageId,
  sender: { userId, verifiedWorkspace },
  text,
  mentionedUserIds: [],
  homeWorkspaceId: "T-HOME",
});

/**
 * Gives the scheduler a bounded number of turns to run other fibers. A fiber the lane holds back
 * stays parked however many turns pass; one it does not hold back finishes within a few.
 */
const settle = (done: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 100 && !(yield* done); turn += 1) yield* Effect.yieldNow;
  });

/** A Slack bot whose transport hands over its access check, with the follow store wrapped. */
const gateHarness = (
  wrapFollowStore?: (store: ChannelFollowStoreShape) => ChannelFollowStoreShape,
) =>
  Effect.gen(function* () {
    let gate: ChannelTransportContext["gate"] | undefined;

    const harness = makeHarness({
      channelOwners: [owner],
      ...(wrapFollowStore ? { wrapFollowStore } : {}),
      startTransport: async (_input, _onDirectMessage, context) => {
        gate = context.gate;

        return {
          externalIdentity: "U-AKERU",
          runtime: { post: async () => undefined, shutdown: async () => undefined },
        };
      },
    });

    yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));

    const check = (input: ChannelGateInput) =>
      Effect.promise(() => {
        if (!gate) throw new Error("Expected the Slack transport.");

        return gate(input);
      });

    const follows = () =>
      harness.followStore.listActive(BOT_ID, "slack", PROJECT_ID, "2000-01-01T00:00:00.000Z");

    return { harness, check, follows };
  });

describe("channel access lane", () => {
  it.effect("lets only one of two concurrent deliveries of a mention change follows", () =>
    Effect.gen(function* () {
      const aClaimed = yield* Deferred.make<void>();
      const releaseA = yield* Deferred.make<void>();
      const bClaimed = yield* Deferred.make<void>();
      const releaseB = yield* Deferred.make<void>();
      let mentionClaims = 0;

      // Each delivery of the mention pauses right after it reads the claim.
      const { check, follows } = yield* gateHarness((store) => ({
        ...store,
        claimMessage: (claimed, at, expiredBefore) =>
          store.claimMessage(claimed, at, expiredBefore).pipe(
            Effect.tap(() => {
              if (claimed.externalMessageId !== "M1") return Effect.void;
              mentionClaims += 1;

              return mentionClaims === 1
                ? Deferred.succeed(aClaimed, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseA)),
                  )
                : Deferred.succeed(bClaimed, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseB)),
                  );
            }),
          ),
      }));

      const first = yield* Effect.forkChild(check(message("mention", "M1", "start")));
      yield* Deferred.await(aClaimed);
      // Slack's redelivery of the same mention arrives while the first is still deciding.
      const second = yield* Effect.forkChild(check(message("mention", "M1", "start")));
      yield* settle(Deferred.isDone(bClaimed));
      yield* Deferred.succeed(releaseA, undefined);
      expect(yield* Fiber.join(first)).toEqual({ type: "turn" });

      const stop = yield* Effect.forkChild(check(message("thread", "S1", "stop")));
      yield* settle(Effect.sync(() => stop.pollUnsafe() !== undefined));
      yield* Deferred.succeed(releaseB, undefined);
      yield* Fiber.join(second);
      expect((yield* Fiber.join(stop)).type).toBe("reply");

      expect(yield* follows()).toEqual([]);
      expect(yield* check(message("thread", "R1", "now do the risky part"))).toEqual({
        type: "ignore",
      });
    }),
  );

  it.effect("answers an owner message delivered while the start is still committing", () =>
    Effect.gen(function* () {
      const secretWriting = yield* Deferred.make<void>();
      const releaseSecret = yield* Deferred.make<void>();
      const { store } = makeMemorySecretStore();
      let gate: ChannelTransportContext["gate"] | undefined;

      const harness = makeHarness({
        channelOwners: [owner],
        // The start attaches its transport, then stores its secret, then saves `connected`.
        secretStore: {
          ...store,
          set: (name, value) =>
            Deferred.succeed(secretWriting, undefined).pipe(
              Effect.andThen(Deferred.await(releaseSecret)),
              Effect.andThen(store.set(name, value)),
            ),
        },
        startTransport: async (_input, _onDirectMessage, context) => {
          gate = context.gate;

          return {
            externalIdentity: "U-AKERU",
            runtime: { post: async () => undefined, shutdown: async () => undefined },
          };
        },
      });

      const connecting = yield* Effect.forkChild(
        connectChannel(harness.dependencies, slackConnect(BOT_ID)),
      );

      yield* Deferred.await(secretWriting);

      // The transport is attached, but its binding is still `connecting`.
      const answer = yield* Effect.forkChild(
        Effect.promise(() => {
          if (!gate) throw new Error("Expected the Slack transport.");

          return gate(message("direct", "E1", "are you there?"));
        }),
      );

      yield* settle(Effect.sync(() => answer.pollUnsafe() !== undefined));
      const decidedWhileCommitting = answer.pollUnsafe() !== undefined;
      yield* Deferred.succeed(releaseSecret, undefined);
      yield* Fiber.join(connecting);

      expect(decidedWhileCommitting).toBe(false);
      expect(yield* Fiber.join(answer)).toEqual({ type: "turn" });
    }),
  );

  it.effect("ignores a message from a transport whose start failed, once the start ends", () =>
    Effect.gen(function* () {
      const delivered = Promise.withResolvers<{ readonly answer: Promise<unknown> }>();
      const release = Promise.withResolvers<void>();
      let answered = false;

      const harness = makeHarness({
        channelOwners: [owner],
        startTransport: async (_input, _onDirectMessage, context) => {
          const early = context.gate(message("direct", "F1", "are you there?"));
          void early.then(() => {
            answered = true;
          });
          // Wrapped, so `delivered` does not wait for the answer.
          delivered.resolve({ answer: early });
          await release.promise;

          return {
            externalIdentity: "U-AKERU",
            // The listener dropped before the start could commit it.
            runtime: {
              post: async () => undefined,
              shutdown: async () => undefined,
              isHealthy: () => false,
            },
          };
        },
      });

      const connecting = yield* Effect.forkChild(
        Effect.flip(connectChannel(harness.dependencies, slackConnect(BOT_ID))),
      );

      const { answer } = yield* Effect.promise(() => delivered.promise);
      // Still starting, so the check waits rather than deciding on the `connecting` binding.
      yield* settle(Effect.sync(() => answered));
      const decidedWhileStarting = answered;
      release.resolve();
      yield* Fiber.join(connecting);

      expect(decidedWhileStarting).toBe(false);
      expect(yield* Effect.promise(() => answer)).toEqual({ type: "ignore" });
    }),
  );

  it.effect("writes no owner when the channel is unassigned during a link attempt", () =>
    Effect.gen(function* () {
      const { harness, check } = yield* gateHarness();
      // The membership lookup is a Promise at the transport boundary, so plain promises drive it.
      const lookupStarted = Promise.withResolvers<void>();
      const lookup = Promise.withResolvers<ChannelSenderMembership>();

      yield* runWith(harness.dependencies, (runtime) =>
        runtime.createLinkCode({
          type: "channel.link-code.create",
          commandId: CommandId.make("link-race"),
          botId: BOT_ID,
          provider: "slack",
          code: "ABCD2345",
        }),
      );

      // The sender's Slack membership lookup is still waiting when the channel is unassigned.
      const attempt = yield* Effect.forkChild(
        check(
          message(
            "direct",
            "L1",
            "ABCD2345",
            () => {
              lookupStarted.resolve();

              return lookup.promise;
            },
            "U-EVE",
          ),
        ),
      );

      yield* Effect.promise(() => lookupStarted.promise);
      yield* detachChannelConnection(harness.dependencies, BOT_ID, "slack");
      lookup.resolve({ kind: "member", workspaceId: "T-HOME" });

      expect(yield* Fiber.join(attempt)).toEqual({ type: "ignore" });
      expect(harness.readSettings().channelOwners).toEqual([owner]);

      // The unassign dropped the code, so connecting the channel again does not revive it.
      yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
      expect(yield* check(message("direct", "L2", "ABCD2345", undefined, "U-SAM"))).toEqual({
        type: "reply",
        text: CHANNEL_LINK_INVALID,
      });
      expect(harness.readSettings().channelOwners).toEqual([owner]);
    }),
  );
});
