import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChannelConnectionId, ProjectId } from "./baseSchemas.ts";
import { CHANNEL_TRANSPORT_CAPABILITIES } from "./orchestration.ts";
import {
  decodeBotAvatar,
  decodeBotEngine,
  decodeOrchestrationBot,
  decodeThreadTurnStartCommand,
  decodeClientOrchestrationCommand,
  decodeOrchestrationCommand,
} from "./orchestration.test-support.ts";

it.effect("decodes every bot avatar variant", () =>
  Effect.gen(function* () {
    assert.deepEqual(
      [
        yield* decodeBotAvatar({ kind: "blob", shape: "squircle", color: "#7357ff" }),
        yield* decodeBotAvatar({ kind: "dither", seed: "scout" }),
        yield* decodeBotAvatar({
          kind: "image",
          assetPath: "bots/scout.png",
          dithered: true,
        }),
      ],
      [
        { kind: "blob", shape: "squircle", color: "#7357ff" },
        { kind: "dither", seed: "scout" },
        { kind: "image", assetPath: "bots/scout.png", dithered: true },
      ],
    );
  }),
);

it.effect("decodes bot engine options while keeping old engines valid", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* decodeBotEngine({ provider: "codex", model: "gpt-5.6-sol" }), {
      provider: "codex",
      model: "gpt-5.6-sol",
    });
    assert.deepStrictEqual(
      yield* decodeBotEngine({
        provider: "codex",
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      }),
      {
        provider: "codex",
        model: "gpt-5.6-sol",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      },
    );
  }),
);

it("defines the frozen conversation policy for every channel provider", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(CHANNEL_TRANSPORT_CAPABILITIES).map(([provider, capabilities]) => [
        provider,
        {
          directMessages: capabilities.directMessages,
          mentions: capabilities.mentions,
          threads: capabilities.threads,
        },
      ]),
    ),
    {
      telegram: { directMessages: true, mentions: false, threads: false },
      imessage: { directMessages: true, mentions: false, threads: false },
      whatsapp: { directMessages: true, mentions: false, threads: false },
      slack: { directMessages: true, mentions: true, threads: true },
      discord: { directMessages: true, mentions: true, threads: true },
    },
  );
});

it("advertises only channel actions exposed by the shipped transports", () => {
  for (const capabilities of Object.values(CHANNEL_TRANSPORT_CAPABILITIES)) {
    assert.equal(capabilities.typing, false);
    assert.equal(capabilities.messageEdits, false);
    assert.equal(capabilities.attachments, false);
    assert.equal(capabilities.interactiveActions, false);
  }

  assert.equal(CHANNEL_TRANSPORT_CAPABILITIES.telegram.reactions, false);
  assert.equal(CHANNEL_TRANSPORT_CAPABILITIES.slack.reactions, true);
  assert.equal(CHANNEL_TRANSPORT_CAPABILITIES.discord.reactions, true);
});

it.effect("decodes live channel commands", () =>
  Effect.gen(function* () {
    const telegram = yield* decodeClientOrchestrationCommand({
      type: "channel.connect",
      commandId: "connect-telegram",
      botId: "bot-1",
      targetProjectId: "project-1",
      provider: "telegram",
      token: " token ",
    });

    const imessage = yield* decodeClientOrchestrationCommand({
      type: "channel.connect",
      commandId: "connect-imessage",
      botId: "bot-1",
      targetProjectId: "project-1",
      provider: "imessage",
      mode: "hosted",
      projectId: " photon-project ",
      projectSecret: " photon-secret ",
    });

    const whatsapp = yield* decodeClientOrchestrationCommand({
      type: "channel.connect",
      commandId: "connect-whatsapp",
      botId: "bot-1",
      targetProjectId: "project-1",
      provider: "whatsapp",
      accessToken: " access-token ",
      appSecret: " app-secret ",
      phoneNumberId: " phone-number-id ",
      verifyToken: " verify-token ",
    });

    const slack = yield* decodeClientOrchestrationCommand({
      type: "channel.connect",
      commandId: "connect-slack",
      botId: "bot-1",
      targetProjectId: "project-1",
      provider: "slack",
      botToken: " xoxb-token ",
      appToken: " xapp-token ",
    });

    const discord = yield* decodeClientOrchestrationCommand({
      type: "channel.connect",
      commandId: "connect-discord",
      botId: "bot-1",
      targetProjectId: "project-1",
      provider: "discord",
      botToken: " discord-token ",
      applicationId: " app-1 ",
      publicKey: " public-key ",
    });

    const saveConnection = yield* decodeClientOrchestrationCommand({
      type: "channel.connection.save",
      commandId: "save-photon",
      connectionId: " photon-work ",
      name: " Work iPhone ",
      provider: "imessage",
      mode: "self-hosted",
      serverUrl: " photon.example:443 ",
      apiKey: " photon-key ",
      phone: " +15551234567 ",
    });

    assert.deepInclude(telegram, { provider: "telegram", token: "token" });
    assert.deepInclude(imessage, {
      provider: "imessage",
      projectId: "photon-project",
      projectSecret: "photon-secret",
    });
    assert.deepInclude(whatsapp, {
      provider: "whatsapp",
      accessToken: "access-token",
      appSecret: "app-secret",
      phoneNumberId: "phone-number-id",
      verifyToken: "verify-token",
    });
    assert.deepInclude(slack, {
      targetProjectId: ProjectId.make("project-1"),
      provider: "slack",
      botToken: "xoxb-token",
      appToken: "xapp-token",
    });
    assert.deepInclude(discord, {
      targetProjectId: ProjectId.make("project-1"),
      provider: "discord",
      botToken: "discord-token",
      applicationId: "app-1",
      publicKey: "public-key",
    });
    assert.deepInclude(saveConnection, {
      connectionId: ChannelConnectionId.make("photon-work"),
      name: "Work iPhone",
      provider: "imessage",
      serverUrl: "photon.example:443",
      apiKey: "photon-key",
      phone: "+15551234567",
    });
  }),
);

it.effect("strips runtime-owned channel fields from client commands", () =>
  Effect.gen(function* () {
    const botUpdate = yield* decodeClientOrchestrationCommand({
      type: "bot.update",
      commandId: "update-bot",
      botId: "bot-1",
      channelBindings: [
        {
          botId: "bot-1",
          provider: "telegram",
          status: "connected",
          externalIdentity: "@forged",
          connectedAt: "2026-08-27T20:00:00.000Z",
          sentMessageIds: [],
        },
      ],
    });

    const turnStart = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "start-turn",
      threadId: "thread-1",
      message: {
        messageId: "message-1",
        role: "user",
        text: "Hello",
        attachments: [],
        channelOrigin: { provider: "telegram", externalThreadId: "forged-chat" },
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-08-27T20:00:00.000Z",
    });

    assert.isFalse("channelBindings" in botUpdate);
    assert.strictEqual(turnStart.type, "thread.turn.start");

    if (turnStart.type === "thread.turn.start") {
      assert.isFalse("channelOrigin" in turnStart.message);
    }
  }),
);

it.effect("defaults omitted bot channel bindings", () =>
  Effect.gen(function* () {
    const bot = yield* decodeOrchestrationBot({
      id: "bot-1",
      name: "Akeru",
      title: "Agent",
      avatar: { kind: "dither", seed: "akeru" },
      engine: null,
      sandbox: "local",
      groupId: null,
      archivedAt: null,
      createdAt: "2026-08-27T20:00:00.000Z",
      updatedAt: "2026-08-27T20:00:00.000Z",
    });

    assert.deepEqual(bot.channelBindings, []);
  }),
);

it.effect("defaults an omitted bot image provider to the global default", () =>
  Effect.gen(function* () {
    const bot = yield* decodeOrchestrationBot({
      id: "bot-1",
      name: "Akeru",
      title: "Agent",
      avatar: { kind: "dither", seed: "akeru" },
      engine: null,
      sandbox: "local",
      groupId: null,
      archivedAt: null,
      createdAt: "2026-08-27T20:00:00.000Z",
      updatedAt: "2026-08-27T20:00:00.000Z",
    });

    assert.strictEqual(bot.imageProvider, null);
  }),
);

it.effect("keeps an explicit bot image provider independent of the chat engine", () =>
  Effect.gen(function* () {
    const bot = yield* decodeOrchestrationBot({
      id: "bot-1",
      name: "Akeru",
      title: "Agent",
      avatar: { kind: "dither", seed: "akeru" },
      engine: { provider: "claudeAgent", model: "claude-opus-5.5" },
      imageProvider: "chatgpt",
      sandbox: "local",
      groupId: null,
      archivedAt: null,
      createdAt: "2026-08-27T20:00:00.000Z",
      updatedAt: "2026-08-27T20:00:00.000Z",
    });

    assert.strictEqual(bot.imageProvider, "chatgpt");
    assert.strictEqual(bot.engine?.provider, "claudeAgent");
  }),
);

it.effect("leaves an omitted bot.create runtime mode for the server", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "bot.create",
      commandId: "cmd-bot-default-runtime",
      botId: "bot-default-runtime",
      name: "Akeru",
      title: "Akeru",
      avatar: { kind: "dither", seed: "akeru" },
      engine: null,
      sandbox: null,
      usageCap: null,
      groupId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    if (parsed.type !== "bot.create") assert.fail(`Expected bot.create, received ${parsed.type}.`);
    assert.strictEqual(parsed.runtimeMode, undefined);
  }),
);

it.effect("accepts both inline and uploaded image attachments from clients", () =>
  Effect.gen(function* () {
    const command = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-attachments",
      threadId: "thread-1",
      message: {
        messageId: "msg-attachments",
        role: "user",
        text: "hello",
        attachments: [
          {
            type: "image",
            name: "legacy.png",
            mimeType: "image/png",
            sizeBytes: 3,
            dataUrl: "data:image/png;base64,YWJj",
          },
          {
            type: "image",
            id: "pending-00000000-0000-4000-8000-000000000001",
            name: "uploaded.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    if (command.type !== "thread.turn.start") {
      assert.fail(`Expected thread.turn.start, received ${command.type}.`);
    }

    assert.strictEqual(command.message.attachments.length, 2);
    assert.strictEqual("dataUrl" in command.message.attachments[0]!, true);
    assert.strictEqual("id" in command.message.attachments[1]!, true);
  }),
);

it.effect("rejects dual ownership in thread.turn.start bootstrap", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      decodeThreadTurnStartCommand({
        type: "thread.turn.start",
        commandId: "cmd-turn-bootstrap-dual-owner",
        threadId: "thread-dual-owner",
        message: {
          messageId: "msg-bootstrap-dual-owner",
          role: "user",
          text: "hello",
          attachments: [],
        },
        bootstrap: {
          createThread: {
            projectId: "project-1",
            botId: "bot-1",
            groupId: "group-1",
            title: "Invalid bootstrap thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    assert.equal(result._tag, "Failure");
  }),
);

it.effect("decodes exclusive thread ownership", () =>
  Effect.gen(function* () {
    const base = {
      type: "thread.create" as const,
      commandId: "cmd-thread-owner",
      threadId: "thread-owned",
      projectId: "project-1",
      title: "Owned thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const owned = yield* decodeOrchestrationCommand({ ...base, botId: "bot-1" });
    assert.equal(owned.type, "thread.create");

    if (owned.type === "thread.create") {
      assert.equal(owned.botId, "bot-1");
      assert.equal(owned.groupId, undefined);
    }

    const invalid = yield* Effect.result(
      decodeOrchestrationCommand({ ...base, botId: "bot-1", groupId: "group-1" }),
    );

    assert.equal(invalid._tag, "Failure");
  }),
);
