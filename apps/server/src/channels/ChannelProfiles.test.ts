import {
  expectFailureMessage,
  connectChannel,
  saveChannelConnection,
  deleteChannelConnection,
  attachChannelConnection,
  disconnectChannel,
  detachChannelConnection,
  reconnectChannel,
  restoreConnectedChannels,
  stopChannelsForBot,
  channelBindingsForRuntime,
  BOT_ID,
  PROJECT_ID,
  makeBot,
  makeMemorySecretStore,
  makeHarness,
  telegramConnect,
  whatsappConnect,
} from "./testUtils/channelRuntime.ts";
import { BotId, ChannelConnectionId, CommandId, DEFAULT_SERVER_SETTINGS } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

describe("channel runtime", () => {
  it.effect("saves, attaches, reconnects, detaches, and deletes a reusable connection", () =>
    Effect.gen(function* () {
      const connectionId = ChannelConnectionId.make("telegram-main");
      const harness = makeHarness({});

      yield* saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("save-connection"),
        connectionId,
        name: "Main Telegram",
        provider: "telegram",
        token: "telegram-token",
      });
      yield* attachChannelConnection(
        harness.dependencies,
        BOT_ID,
        connectionId,
        PROJECT_ID,
        "telegram",
      );
      expect(harness.readSettings().channelConnections).toEqual([
        {
          id: connectionId,
          name: "Main Telegram",
          provider: "telegram",
          adapter: "telegram",
        },
      ]);
      expect(harness.readModel().bots[0]?.channelBindings?.[0]).toMatchObject({
        connectionId,
        provider: "telegram",
        status: "connected",
      });

      yield* expectFailureMessage(
        saveChannelConnection(harness.dependencies, {
          type: "channel.connection.save",
          commandId: CommandId.make("edit-attached-connection"),
          connectionId,
          name: "Changed Telegram",
          provider: "telegram",
          token: "changed-token",
        }),
        "Unassign this channel before editing it",
      );

      yield* expectFailureMessage(
        deleteChannelConnection(harness.dependencies, connectionId),
        "Unassign this channel",
      );
      yield* stopChannelsForBot(BOT_ID);
      yield* reconnectChannel(harness.dependencies, BOT_ID, "telegram");
      yield* disconnectChannel(harness.dependencies, BOT_ID, "telegram");
      yield* reconnectChannel(harness.dependencies, BOT_ID, "telegram");
      yield* disconnectChannel(harness.dependencies, BOT_ID, "telegram");
      yield* expectFailureMessage(
        deleteChannelConnection(harness.dependencies, connectionId),
        "Unassign this channel before deleting it",
      );
      yield* detachChannelConnection(harness.dependencies, BOT_ID, "telegram");
      expect(harness.secrets.size).toBe(1);
      yield* deleteChannelConnection(harness.dependencies, connectionId);
      expect(harness.secrets.size).toBe(0);
      expect(harness.readSettings().channelConnections).toEqual([]);
    }),
  );

  it.effect("serializes multiple reusable connection profiles", () =>
    Effect.gen(function* () {
      const telegramId = ChannelConnectionId.make("telegram-work");
      const photonId = ChannelConnectionId.make("photon-personal");
      const harness = makeHarness({});

      yield* Effect.all(
        [
          saveChannelConnection(harness.dependencies, {
            type: "channel.connection.save",
            commandId: CommandId.make("save-telegram"),
            connectionId: telegramId,
            name: "Work Telegram",
            provider: "telegram",
            token: "telegram-token",
          }),
          saveChannelConnection(harness.dependencies, {
            type: "channel.connection.save",
            commandId: CommandId.make("save-photon"),
            connectionId: photonId,
            name: "Personal iPhone",
            provider: "imessage",
            mode: "self-hosted",
            serverUrl: "photon.example:443",
            apiKey: "photon-key",
            phone: "+15551234567",
          }),
        ],
        { concurrency: "unbounded" },
      );

      expect(harness.readSettings().channelConnections).toEqual([
        {
          id: telegramId,
          name: "Work Telegram",
          provider: "telegram",
          adapter: "telegram",
        },
        {
          id: photonId,
          name: "Personal iPhone",
          provider: "imessage",
          adapter: "photon",
          externalIdentity: "+15551234567",
        },
      ]);
    }),
  );

  it.effect("stores a safe dashboard link for hosted Photon", () =>
    Effect.gen(function* () {
      const connectionId = ChannelConnectionId.make("photon-hosted");
      const harness = makeHarness({});

      yield* saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("save-photon-hosted"),
        connectionId,
        name: "Launch iPhone",
        provider: "imessage",
        mode: "hosted",
        projectId: "project/launch",
        projectSecret: "never-in-settings",
      });

      expect(harness.readSettings().channelConnections).toEqual([
        {
          id: connectionId,
          name: "Launch iPhone",
          provider: "imessage",
          adapter: "photon",
          externalIdentity: "project/launch",
          managementUrl: "https://app.photon.codes/dashboard/project%2Flaunch",
        },
      ]);
      // @effect-diagnostics-next-line preferSchemaOverJson:off - scans the persisted settings text.
      expect(JSON.stringify(harness.readSettings().channelConnections)).not.toContain(
        "never-in-settings",
      );
    }),
  );

  it.effect("rolls back a saved secret when profile persistence fails", () =>
    Effect.gen(function* () {
      const connectionId = ChannelConnectionId.make("failed-profile");

      const harness = makeHarness({
        settings: {
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.die(new Error("settings write failed")),
        },
      });

      yield* expectFailureMessage(
        saveChannelConnection(harness.dependencies, {
          type: "channel.connection.save",
          commandId: CommandId.make("save-failed-profile"),
          connectionId,
          name: "Failed profile",
          provider: "telegram",
          token: "telegram-token",
        }),
        "settings write failed",
      );
      expect(harness.secrets.size).toBe(0);
    }),
  );

  it.effect("restores saved WhatsApp credentials", () =>
    Effect.gen(function* () {
      let starts = 0;

      const harness = makeHarness({
        startTransport: async (input) => {
          starts += 1;
          expect(input).toMatchObject({
            provider: "whatsapp",
            accessToken: "access-token",
            appSecret: "app-secret",
            phoneNumberId: "phone-number-id",
            verifyToken: "verify-token",
          });

          return {
            externalIdentity: "phone-number-id",
            runtime: { post: async () => undefined, shutdown: async () => undefined },
          };
        },
      });

      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
      yield* stopChannelsForBot(BOT_ID);
      yield* restoreConnectedChannels(harness.dependencies);

      expect(starts).toBe(2);
    }),
  );

  it.effect("uses collision-free secret names for distinct bot IDs", () =>
    Effect.gen(function* () {
      const firstId = BotId.make("sales/east");
      const secondId = BotId.make("sales?east");
      const harness = makeHarness({ bots: [makeBot(firstId), makeBot(secondId)] });

      yield* connectChannel(harness.dependencies, telegramConnect(firstId, "token-1"));
      yield* connectChannel(harness.dependencies, telegramConnect(secondId, "token-2"));

      expect(harness.secrets.size).toBe(2);
      expect([...harness.secrets.keys()].every((name) => !name.includes("sales"))).toBe(true);
    }),
  );

  it.effect("stops a new transport when reading the previous secret fails", () =>
    Effect.gen(function* () {
      const { store } = makeMemorySecretStore();
      let stops = 0;

      const harness = makeHarness({
        secretStore: { ...store, get: () => Effect.die(new Error("secret read failed")) },
        shutdown: async () => void (stops += 1),
      });

      yield* expectFailureMessage(
        connectChannel(harness.dependencies, telegramConnect(BOT_ID)),
        "secret read failed",
      );

      expect(stops).toBe(1);
      expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
    }),
  );

  it.effect("keeps a connected runtime when removing its secret fails", () =>
    Effect.gen(function* () {
      const { store, values } = makeMemorySecretStore();
      let failRemove = false;
      let stops = 0;

      const harness = makeHarness({
        secretStore: {
          ...store,
          remove: (name) =>
            failRemove ? Effect.die(new Error("secret remove failed")) : store.remove(name),
        },
        shutdown: async () => void (stops += 1),
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      failRemove = true;

      yield* expectFailureMessage(
        detachChannelConnection(harness.dependencies, BOT_ID, "telegram"),
        "secret remove failed",
      );

      const binding = harness.readModel().bots[0]?.channelBindings?.[0];
      expect(binding?.status).toBe("connected");
      expect(binding && channelBindingsForRuntime([binding])).toEqual([binding]);
      expect(values.size).toBe(1);
      expect(stops).toBe(0);
    }),
  );

  it.effect("restores the direct credential when unassign persistence fails", () =>
    Effect.gen(function* () {
      let stops = 0;

      const harness = makeHarness({
        failBotUpdate: (index) => (index === 3 ? new Error("binding write failed") : undefined),
        shutdown: async () => void (stops += 1),
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      const credentials = [...harness.secrets.entries()];

      yield* expectFailureMessage(
        detachChannelConnection(harness.dependencies, BOT_ID, "telegram"),
        "binding write failed",
      );

      expect([...harness.secrets.entries()]).toEqual(credentials);
      const binding = harness.readModel().bots[0]?.channelBindings[0];
      expect(binding?.status).toBe("connected");
      expect(binding && channelBindingsForRuntime([binding])).toEqual([binding]);
      expect(stops).toBe(0);
    }),
  );

  it.effect("rejects one Telegram token bound to two active bots", () =>
    Effect.gen(function* () {
      const secondId = BotId.make("bot-2");
      const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      yield* expectFailureMessage(
        connectChannel(harness.dependencies, telegramConnect(secondId)),
        "already connected",
      );
    }),
  );

  it.effect("rejects one WhatsApp number bound to two active bots", () =>
    Effect.gen(function* () {
      const secondId = BotId.make("bot-2");
      const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

      yield* connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
      yield* expectFailureMessage(
        connectChannel(harness.dependencies, whatsappConnect(secondId)),
        "already connected",
      );
    }),
  );

  it.effect("serializes concurrent WhatsApp identity claims", () =>
    Effect.gen(function* () {
      const secondId = BotId.make("bot-2");
      const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

      const results = yield* Effect.all(
        [
          Effect.exit(connectChannel(harness.dependencies, whatsappConnect(BOT_ID))),
          Effect.exit(connectChannel(harness.dependencies, whatsappConnect(secondId))),
        ],
        { concurrency: "unbounded" },
      );

      expect(results.filter(Exit.isSuccess)).toHaveLength(1);
      expect(results.filter(Exit.isFailure)).toHaveLength(1);
      expect(
        harness
          .readModel()
          .bots.flatMap((bot) => bot.channelBindings ?? [])
          .filter((binding) => binding.provider === "whatsapp" && binding.status === "connected"),
      ).toHaveLength(1);
    }),
  );
});
