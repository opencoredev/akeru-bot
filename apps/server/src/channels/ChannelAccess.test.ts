import {
  BOT_ID,
  NOW,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  changeChannelProject,
  connectChannel,
  disconnectChannel,
  externalAdapters,
  runWith,
  slackConnect,
} from "./testUtils/channelRuntime.ts";
import {
  HOUR,
  THREAD,
  THREAD_TS,
  acceptPosts,
  atOffset,
  deliver,
  deliverEvent,
  directMessage,
  historyReads,
  mention,
  owner,
  postedTexts,
  setup,
  threadReply,
} from "./testUtils/slackAccessFixtures.ts";
import { CommandId } from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import {
  CHANNEL_LINK_EXTERNAL,
  CHANNEL_LINK_INSTRUCTIONS,
  CHANNEL_LINK_INVALID,
  CHANNEL_STOP_REPLY,
} from "./ChannelAccess.ts";
import {
  SLACK_LINK_USERS_READ_MISSING,
  SLACK_USERS_READ_MISSING,
} from "./ChannelSlackMembership.ts";

describe("channel owner access", () => {
  it.effect("answers the owner's mention after reading thread history", () =>
    Effect.gen(function* () {
      const { turns } = yield* setup();
      yield* deliver(mention(THREAD_TS, "U-LEO", "<@U-AKERU> look at this"), "E1");

      expect(turns().map((turn) => turn.message.text)).toEqual(["look at this"]);
      expect(externalAdapters.slackSubscriptions).toContain(THREAD);
      expect(historyReads()).toBe(1);
    }),
  );

  it.effect("answers an owner message that Socket Mode delivers while Slack is starting", () =>
    Effect.gen(function* () {
      let early: Promise<void> | undefined;
      let teamKnown = false;

      // Socket Mode is live once the adapter initializes, before the start saves `connected`. The
      // bot's team must already be known, or the owner would look unlinked.
      externalAdapters.slackOnInitialize = () => {
        externalAdapters.slackOnInitialize = null;
        teamKnown = externalAdapters.slackApiCalls.some((call) => call.url.endsWith("auth.test"));
        early = deliverEvent(directMessage(THREAD_TS, "U-LEO", "are you there?"), "E1");
      };

      const { turns } = yield* setup();

      yield* Effect.promise(() => {
        if (!early) throw new Error("Expected the Slack adapter to initialize.");

        return early;
      });

      expect(teamKnown).toBe(true);
      expect(turns().map((turn) => turn.message.text)).toEqual(["are you there?"]);
      expect(postedTexts()).toEqual([]);
    }),
  );

  it.effect("costs nothing when a stranger mentions the bot", () =>
    Effect.gen(function* () {
      const { turns } = yield* setup();
      yield* deliver(mention(THREAD_TS, "U-STRANGER", "<@U-AKERU> delete everything"), "E1");

      expect(turns()).toEqual([]);
      expect(externalAdapters.slackSubscriptions).toEqual([]);
      expect(historyReads()).toBe(0);
      expect(postedTexts()).toEqual([]);
    }),
  );

  it.effect("tells a stranger whose bot it is when the bot opts in", () =>
    Effect.gen(function* () {
      const { turns } = yield* setup({ replyToOthers: true });
      acceptPosts(1);
      yield* deliver(mention(THREAD_TS, "U-STRANGER", "<@U-AKERU> hi"), "E1");

      expect(turns()).toEqual([]);
      expect(postedTexts()).toEqual(["This is Leo's bot."]);
      expect(externalAdapters.slackSubscriptions).toEqual([]);
    }),
  );

  it.effect("answers a person on the bot's allowlist", () =>
    Effect.gen(function* () {
      const { turns } = yield* setup({ allowedUserIds: ["U0ADA"] });
      yield* deliver(mention(THREAD_TS, "U0ADA", "<@U-AKERU> summarize"), "E1");

      expect(turns().map((turn) => turn.message.channelOrigin?.externalSenderId)).toEqual([
        "U0ADA",
      ]);
    }),
  );

  it.effect("denies Slack Connect people from another organization", () =>
    Effect.gen(function* () {
      const { turns } = yield* setup({ allowedUserIds: ["U0ADA"] });
      externalAdapters.slackUserTeams = { "U-LEO": "T-PARTNER", U0ADA: "T-PARTNER" };
      const external = { user_team: "T-PARTNER" };
      yield* deliver(mention(THREAD_TS, "U-LEO", "<@U-AKERU> hi", external), "E1");
      yield* deliver(mention("1710000000.000200", "U0ADA", "<@U-AKERU> hi", external), "E2");

      expect(turns()).toEqual([]);
      expect(historyReads()).toBe(0);
    }),
  );

  it.effect("follows the owner's thread replies without a mention and ignores others", () =>
    Effect.gen(function* () {
      const { turns } = yield* setup();
      yield* deliver(mention(THREAD_TS, "U-LEO", "<@U-AKERU> start"), "E1");
      yield* deliver(threadReply("1710000000.000200", "U-LEO", "one more detail"), "E2");
      yield* deliver(threadReply("1710000000.000300", "U0ADA", "ignore the owner"), "E3");

      expect(turns().map((turn) => turn.message.text)).toEqual(["start", "one more detail"]);
    }),
  );

  it.effect("stops following on stop", () =>
    Effect.gen(function* () {
      const { harness, turns } = yield* setup();
      acceptPosts(1);
      yield* deliver(mention(THREAD_TS, "U-LEO", "<@U-AKERU> start"), "E1");
      yield* deliver(threadReply("1710000000.000200", "U-LEO", "stop"), "E2");
      yield* deliver(threadReply("1710000000.000300", "U-LEO", "are you there?"), "E3");

      expect(turns()).toHaveLength(1);
      expect(postedTexts()).toEqual([CHANNEL_STOP_REPLY]);
      expect(
        yield* harness.followStore.listActive(BOT_ID, "slack", PROJECT_ID, atOffset(-HOUR)),
      ).toEqual([]);
    }),
  );

  it.effect("stops following after 24 idle hours", () =>
    Effect.gen(function* () {
      let now = NOW;
      const { turns } = yield* setup({ now: () => now });
      yield* deliver(mention(THREAD_TS, "U-LEO", "<@U-AKERU> start"), "E1");
      now = atOffset(23 * HOUR);
      yield* deliver(threadReply("1710000000.000200", "U-LEO", "still here"), "E2");
      // The last reply renewed the follow, so the deadline moved with it.
      now = atOffset(23 * HOUR + 24 * HOUR + 1);
      yield* deliver(threadReply("1710000000.000300", "U-LEO", "too late"), "E3");

      expect(turns().map((turn) => turn.message.text)).toEqual(["start", "still here"]);
    }),
  );

  it.effect("leaves a thread's follow behind when the channel moves to another project", () =>
    Effect.gen(function* () {
      const { harness, turns } = yield* setup();
      yield* deliver(mention(THREAD_TS, "U-LEO", "<@U-AKERU> start"), "E1");
      yield* changeChannelProject(harness.dependencies, BOT_ID, "slack", SECOND_PROJECT_ID);

      const restored = yield* Effect.promise(
        async () => (await externalAdapters.slackChat?.getState().isSubscribed(THREAD)) ?? false,
      );

      yield* deliver(threadReply("1710000000.000200", "U-LEO", "one more detail"), "E2");

      expect(restored).toBe(false);
      expect(turns().map((turn) => turn.message.text)).toEqual(["start"]);
      expect(
        yield* harness.followStore.listActive(BOT_ID, "slack", SECOND_PROJECT_ID, atOffset(-HOUR)),
      ).toEqual([]);
    }),
  );

  it.effect("stops following when the owner mentions a different bot", () =>
    Effect.gen(function* () {
      const { turns } = yield* setup();
      yield* deliver(mention(THREAD_TS, "U-LEO", "<@U-AKERU> start"), "E1");
      yield* deliver(threadReply("1710000000.000200", "U-LEO", "<@U0OTHER> take over"), "E2");
      yield* deliver(threadReply("1710000000.000300", "U-LEO", "thanks"), "E3");

      expect(turns().map((turn) => turn.message.text)).toEqual(["start"]);
    }),
  );

  it.effect("starts one turn when Slack redelivers an event", () =>
    Effect.gen(function* () {
      const { turns } = yield* setup();
      const event = mention(THREAD_TS, "U-LEO", "<@U-AKERU> once");
      yield* deliver(event, "E1");
      yield* deliver(event, "E1", 1);
      yield* deliver(event, "E1-again");

      expect(turns()).toHaveLength(1);
    }),
  );

  it.effect("never starts a turn for an edited message", () =>
    Effect.gen(function* () {
      const { turns } = yield* setup();
      yield* deliver(mention(THREAD_TS, "U-LEO", "<@U-AKERU> first"), "E1");
      yield* deliver(
        {
          type: "message",
          subtype: "message_changed",
          channel: "C1",
          channel_type: "channel",
          message: {
            ...threadReply("1710000000.000200", "U-LEO", "<@U-AKERU> edited"),
            edited: { user: "U-LEO", ts: "1710000001.000000" },
          },
          previous_message: threadReply("1710000000.000200", "U-LEO", "<@U-AKERU> draft"),
        },
        "E2",
      );

      expect(turns().map((turn) => turn.message.text)).toEqual(["first"]);
    }),
  );

  it.effect("renders other people's mentions as display names", () =>
    Effect.gen(function* () {
      const { turns } = yield* setup();
      externalAdapters.slackUserNames = { U0ADA: "Ada", "U-LEO": "Leo" };
      externalAdapters.slackMissingUsers = ["U0NOBODY"];
      yield* deliver(mention(THREAD_TS, "U-LEO", "<@U-AKERU> ask <@U0ADA> and <@U0NOBODY>"), "E1");

      expect(turns().map((turn) => turn.message.text)).toEqual(["ask @Ada and @U0NOBODY"]);
    }),
  );
});

describe("channel owner link codes", () => {
  const createCode = (dependencies: Parameters<typeof runWith>[0], code: string) =>
    runWith(dependencies, (runtime) =>
      runtime.createLinkCode({
        type: "channel.link-code.create",
        commandId: CommandId.make(`link-${code}`),
        botId: BOT_ID,
        provider: "slack",
        code,
      }),
    );

  it.effect("explains how to link while no owner is linked", () =>
    Effect.gen(function* () {
      const { turns } = yield* setup({ owners: [] });
      acceptPosts(2);
      yield* deliver(directMessage("1710000000.000050", "U-LEO", "hello"), "E1");
      yield* deliver(mention(THREAD_TS, "U-LEO", "<@U-AKERU> hi"), "E2");

      expect(turns()).toEqual([]);
      expect(postedTexts()).toEqual([CHANNEL_LINK_INSTRUCTIONS, CHANNEL_LINK_INSTRUCTIONS]);
      expect(historyReads()).toBe(0);
    }),
  );

  it.effect("links the sender of a valid code, then answers their DMs", () =>
    Effect.gen(function* () {
      const { harness, turns } = yield* setup({ owners: [] });
      yield* createCode(harness.dependencies, "ABCD2345");
      acceptPosts(1);
      externalAdapters.slackUserNames = { "U-LEO": "Leo" };
      yield* deliver(directMessage("1710000000.000100", "U-LEO", "abcd2345"), "E1");
      yield* deliver(directMessage("1710000000.000200", "U-LEO", "now help me"), "E2");

      expect(harness.readSettings().channelOwners).toEqual([
        {
          provider: "slack",
          workspaceId: "T-HOME",
          userId: "U-LEO",
          displayName: "Leo",
          linkedAt: NOW,
        },
      ]);
      expect(postedTexts()).toEqual([
        "Linked. Scout now answers you here, and in threads after you mention it.",
      ]);
      expect(turns().map((turn) => turn.message.text)).toEqual(["now help me"]);
    }),
  );

  it.effect("links an owner for a bot connected without a saved connection", () =>
    Effect.gen(function* () {
      const { harness } = yield* setup({ owners: [] });

      const binding = harness
        .readModel()
        .bots.find((bot) => bot.id === BOT_ID)
        ?.channelBindings.find((candidate) => candidate.provider === "slack");

      expect(binding?.status).toBe("connected");
      expect(binding?.connectionId).toBeUndefined();

      yield* createCode(harness.dependencies, "ABCD2345");
      acceptPosts(1);
      yield* deliver(directMessage("1710000000.000100", "U-LEO", "ABCD2345"), "E1");

      expect(harness.readSettings().channelOwners.map((entry) => entry.userId)).toEqual(["U-LEO"]);
    }),
  );

  it.effect("refuses a code made before a channel without a saved connection reconnected", () =>
    Effect.gen(function* () {
      const { harness } = yield* setup({ owners: [] });
      yield* createCode(harness.dependencies, "ABCD2345");

      // A direct connect replaces the running transport, possibly with another Slack account, and
      // neither binding has a connection ID that would tell the two apart.
      yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
      acceptPosts(1);
      yield* deliver(directMessage("1710000000.000100", "U-LEO", "ABCD2345"), "E1");

      expect(harness.readSettings().channelOwners).toEqual([]);
      expect(postedTexts()).toEqual([CHANNEL_LINK_INVALID]);
    }),
  );

  it.effect("starts no turn when the platform redelivers a link DM after it linked", () =>
    Effect.gen(function* () {
      const { harness, turns } = yield* setup({ owners: [] });
      yield* createCode(harness.dependencies, "ABCD2345");
      acceptPosts(1);
      const linkDm = directMessage("1710000000.000100", "U-LEO", "ABCD2345");
      yield* deliver(linkDm, "E1");

      // A fresh transport has a fresh SDK state, so its in-memory dedupe has forgotten E1.
      yield* disconnectChannel(harness.dependencies, BOT_ID, "slack");
      yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
      yield* deliver(linkDm, "E1-replayed");

      expect(harness.readSettings().channelOwners.map((entry) => entry.userId)).toEqual(["U-LEO"]);
      expect(turns()).toEqual([]);
    }),
  );

  it.effect("rejects an expired code", () =>
    Effect.gen(function* () {
      let now = NOW;
      const { harness } = yield* setup({ owners: [], now: () => now });
      yield* createCode(harness.dependencies, "ABCD2345");
      now = atOffset(10 * 60 * 1000);
      acceptPosts(1);
      yield* deliver(directMessage("1710000000.000100", "U-LEO", "ABCD2345"), "E1");

      expect(harness.readSettings().channelOwners).toEqual([]);
      expect(postedTexts()).toEqual([CHANNEL_LINK_INVALID]);
    }),
  );

  it.effect("accepts a code only once", () =>
    Effect.gen(function* () {
      const { harness } = yield* setup({ owners: [] });
      yield* createCode(harness.dependencies, "ABCD2345");
      acceptPosts(2);
      yield* deliver(directMessage("1710000000.000100", "U-LEO", "ABCD2345"), "E1");
      yield* deliver(directMessage("1710000000.000200", "U-MALLORY", "ABCD2345"), "E2");

      expect(harness.readSettings().channelOwners.map((entry) => entry.userId)).toEqual(["U-LEO"]);
      expect(postedTexts().at(-1)).toBe(CHANNEL_LINK_INVALID);
    }),
  );

  it.effect("never links someone from another organization", () =>
    Effect.gen(function* () {
      const { harness } = yield* setup({ owners: [] });
      yield* createCode(harness.dependencies, "ABCD2345");
      externalAdapters.slackUserTeams = { "U-PARTNER": "T-PARTNER" };
      acceptPosts(1);
      yield* deliver(
        directMessage("1710000000.000100", "U-PARTNER", "ABCD2345", { user_team: "T-PARTNER" }),
        "E1",
      );

      expect(harness.readSettings().channelOwners).toEqual([]);
      expect(postedTexts()).toEqual([CHANNEL_LINK_EXTERNAL]);
    }),
  );

  it.effect("keeps the users:read warning until the channel reconnects", () =>
    Effect.gen(function* () {
      const { harness, turns } = yield* setup();
      externalAdapters.slackScopes = ["chat:write", "app_mentions:read", "im:history"];
      yield* deliver(directMessage("1710000000.000100", "U-LEO", "first"), "E1");

      const slackBinding = () =>
        harness
          .readModel()
          .bots.find((bot) => bot.id === BOT_ID)
          ?.channelBindings.find((candidate) => candidate.provider === "slack");

      expect(slackBinding()?.lastError).toBe(SLACK_USERS_READ_MISSING);

      // The owner added users:read and reinstalled the app. A message alone does not clear the
      // warning, since a cached lookup could predate the change; reconnecting reads the scopes.
      externalAdapters.slackScopes = undefined;
      yield* deliver(directMessage("1710000000.000200", "U-LEO", "second"), "E2");
      expect(slackBinding()?.lastError).toBe(SLACK_USERS_READ_MISSING);

      yield* disconnectChannel(harness.dependencies, BOT_ID, "slack");
      yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
      expect(slackBinding()).not.toHaveProperty("lastError");
      yield* deliver(directMessage("1710000000.000300", "U-LEO", "third"), "E3");
      expect(turns().map((turn) => turn.message.text)).toContain("third");
    }),
  );

  it.effect("tells the owner to add users:read when the Slack app lacks it", () =>
    Effect.gen(function* () {
      const { harness } = yield* setup({ owners: [] });
      yield* createCode(harness.dependencies, "ABCD2345");
      // The app was set up from the earlier guide, which did not ask for users:read.
      externalAdapters.slackScopes = ["chat:write", "app_mentions:read", "im:history"];
      acceptPosts(1);
      yield* deliver(directMessage("1710000000.000100", "U-LEO", "ABCD2345"), "E1");

      const binding = harness
        .readModel()
        .bots.find((bot) => bot.id === BOT_ID)
        ?.channelBindings.find((candidate) => candidate.provider === "slack");

      expect(harness.readSettings().channelOwners).toEqual([]);
      expect(postedTexts()).toEqual([SLACK_LINK_USERS_READ_MISSING]);
      expect(binding).toMatchObject({ status: "connected", lastError: SLACK_USERS_READ_MISSING });
      expect(binding?.failureCategory).toBeUndefined();
    }),
  );

  it.effect("warns at connect when the Slack token lacks users:read", () =>
    Effect.gen(function* () {
      externalAdapters.slackScopes = ["chat:write", "im:history"];
      const { harness } = yield* setup({ owners: [] });

      const binding = () =>
        harness
          .readModel()
          .bots.find((bot) => bot.id === BOT_ID)
          ?.channelBindings.find((candidate) => candidate.provider === "slack");

      expect(binding()).toMatchObject({ status: "connected", lastError: SLACK_USERS_READ_MISSING });

      // After the scope is added and the app reinstalled, a reconnect clears the warning.
      externalAdapters.slackScopes = ["chat:write", "im:history", "users:read"];
      yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));

      expect(binding()?.status).toBe("connected");
      expect(binding()?.lastError).toBeUndefined();
    }),
  );

  it.effect("stops answering an owner once their identity is removed", () =>
    Effect.gen(function* () {
      const { harness, turns } = yield* setup({ owners: [owner("U-LEO"), owner("U-SAM")] });
      yield* runWith(harness.dependencies, (runtime) =>
        runtime.removeOwner({
          type: "channel.owner.remove",
          commandId: CommandId.make("remove-leo"),
          provider: "slack",
          workspaceId: "T-HOME",
          userId: "U-LEO",
        }),
      );
      yield* deliver(directMessage("1710000000.000100", "U-LEO", "hello"), "E1");

      expect(harness.readSettings().channelOwners.map((entry) => entry.userId)).toEqual(["U-SAM"]);
      expect(turns()).toEqual([]);
    }),
  );
});
