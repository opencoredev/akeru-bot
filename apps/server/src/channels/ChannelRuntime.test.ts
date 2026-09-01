import * as NodeCrypto from "node:crypto";

import {
  BotId,
  ChannelConnectionId,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ChannelBinding,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import type { iMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { Message as ChatMessage, parseMarkdown, type Adapter, type ChatInstance } from "chat";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { it } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vite-plus/test";

const photon = vi.hoisted(() => ({
  adapter: null as iMessageAdapter | null,
  chat: null as ChatInstance | null,
  failedSubscription: null as string | null,
  subscriptionAttempts: [] as string[],
}));

vi.mock("@photon-ai/chat-adapter-imessage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@photon-ai/chat-adapter-imessage")>();
  return {
    ...actual,
    createiMessageAdapter: (
      options: Parameters<typeof actual.createiMessageAdapter>[0],
    ): iMessageAdapter => {
      const adapter = actual.createiMessageAdapter(options) as iMessageAdapter & Adapter;
      adapter.initialize = async (chat) => {
        photon.adapter = adapter;
        photon.chat = chat;
      };
      adapter.startGatewayListener = async () => new Response(null, { status: 200 });
      adapter.onThreadSubscribe = async (threadId) => {
        photon.subscriptionAttempts.push(threadId);
        if (threadId === photon.failedSubscription) throw new Error("invalid group GUID");
      };
      adapter.disconnect = async () => undefined;
      return adapter;
    },
  };
});

import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { createEmptyReadModel } from "../orchestration/projector.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeMemoryChannelDeliveryStore } from "./ChannelDeliveryStore.ts";
import {
  attachChannelConnection,
  channelBindingsForRuntime,
  channelThreadId,
  connectChannel,
  deleteChannelConnection,
  disconnectChannel,
  dispatchInboundChannelMessage,
  handleWhatsAppWebhook,
  reconnectChannel,
  saveChannelConnection,
  restoreConnectedChannels,
  sendCompletedChannelReply,
  sendChannelMessage,
  shutdownAllChannels,
  stopArchivedBotChannels,
  stopChannelsForBot,
  type ChannelRuntimeDependencies,
} from "./ChannelRuntime.ts";

const NOW = "2026-08-27T20:00:00.000Z";
const BOT_ID = BotId.make("bot-1");
const PROJECT_ID = ProjectId.make("project-1");

function makeBot(
  id: BotId,
  input: {
    readonly name?: string;
    readonly archivedAt?: string | null;
    readonly channelBindings?: ReadonlyArray<ChannelBinding>;
  } = {},
): OrchestrationBot {
  return {
    id,
    name: input.name ?? id,
    title: "Agent",
    label: null,
    description: null,
    disabledMcpServerIds: [],
    avatar: { kind: "dither", seed: id },
    engine: null,
    sandbox: "local",
    runtimeMode: "full-access",
    usageCap: null,
    voiceEnabled: false,
    channelBindings: input.channelBindings ?? [],
    groupId: null,
    archivedAt: input.archivedAt ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeModel(bots: ReadonlyArray<OrchestrationBot>): OrchestrationReadModel {
  return {
    ...createEmptyReadModel(NOW),
    snapshotSequence: 12,
    bots,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6",
        },
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
  };
}

function makeMessage(
  id: MessageId,
  role: OrchestrationMessage["role"],
  text: string,
  channelOrigin?: OrchestrationMessage["channelOrigin"],
): OrchestrationMessage {
  return {
    id,
    role,
    text,
    turnId: null,
    ...(channelOrigin !== undefined ? { channelOrigin } : {}),
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeChatSdkMessage(threadId: string, id: string, text: string, senderId: string) {
  return new ChatMessage({
    id,
    threadId,
    text,
    formatted: parseMarkdown(text),
    raw: {},
    author: {
      userId: senderId,
      userName: senderId,
      fullName: senderId,
      isBot: false,
      isMe: false,
    },
    // @effect-diagnostics-next-line globalDate:off - Chat SDK Message requires a Date fixture.
    metadata: { dateSent: new Date(NOW), edited: false },
    attachments: [],
    isMention: false,
  });
}

function makeThread(
  id: ThreadId,
  botId: BotId,
  messages: ReadonlyArray<OrchestrationMessage>,
): OrchestrationThread {
  return {
    id,
    projectId: PROJECT_ID,
    botId,
    groupId: null,
    title: "Channel thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeMemorySecretStore() {
  const values = new Map<string, Uint8Array>();
  const store: ServerSecretStore["Service"] = {
    get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const value = values.get(name) ?? new Uint8Array(bytes);
        values.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  };
  return { store, values };
}

function makeHarness(input: {
  readonly bots?: ReadonlyArray<OrchestrationBot>;
  readonly threads?: ReadonlyArray<OrchestrationThread>;
  readonly post?: (externalThreadId: string, text: string) => Promise<void>;
  readonly shutdown?: () => Promise<void>;
  readonly deliveryStore?: ChannelRuntimeDependencies["deliveryStore"];
  readonly secretStore?: ChannelRuntimeDependencies["secretStore"];
  readonly settings?: ChannelRuntimeDependencies["settings"];
  readonly startTransport?: ChannelRuntimeDependencies["startTransport"] | null;
  readonly failBotUpdate?: (updateIndex: number) => Error | undefined;
}) {
  let model = makeModel(input.bots ?? [makeBot(BOT_ID)]);
  let settings = DEFAULT_SERVER_SETTINGS;
  const threads = [...(input.threads ?? [])];
  const commands: OrchestrationCommand[] = [];
  const { store: memorySecretStore, values: secrets } = makeMemorySecretStore();
  const secretStore = input.secretStore ?? memorySecretStore;
  let sequence = model.snapshotSequence;
  let botUpdateIndex = 0;
  const dispatch = (command: OrchestrationCommand) =>
    Effect.sync(() => {
      if (command.type === "bot.update") {
        botUpdateIndex += 1;
        const failure = input.failBotUpdate?.(botUpdateIndex);
        if (failure) throw failure;
      }
      commands.push(command);
      sequence += 1;
      const channelBindings = command.type === "bot.update" ? command.channelBindings : undefined;
      if (channelBindings !== undefined) {
        const botId = command.type === "bot.update" ? command.botId : undefined;
        model = {
          ...model,
          snapshotSequence: sequence,
          bots: model.bots.map((bot) => (bot.id === botId ? { ...bot, channelBindings } : bot)),
        };
      }
      if (command.type === "thread.create") {
        threads.push(makeThread(command.threadId, command.botId!, []));
        model = { ...model, threads };
      }
      return { sequence };
    });
  const engine = {
    readEvents: () => Stream.empty,
    dispatch,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.sync(() => sequence),
  } satisfies OrchestrationEngineShape;
  const dependencies: ChannelRuntimeDependencies = {
    engine,
    secretStore,
    settings: input.settings ?? {
      getSettings: Effect.sync(() => settings),
      updateSettings: (patch) =>
        Effect.sync(() => {
          settings = { ...settings, ...patch } as typeof settings;
          return settings;
        }),
    },
    deliveryStore: input.deliveryStore ?? makeMemoryChannelDeliveryStore(),
    readModel: async () => ({ ...model, threads }),
    readThread: async (threadId) => threads.find((thread) => thread.id === threadId) ?? null,
    nowIso: async () => NOW,
    randomUuid: async () => `uuid-${commands.length}`,
    ...(input.startTransport === null
      ? {}
      : {
          startTransport:
            input.startTransport ??
            (async () => ({
              externalIdentity: "@akeru",
              runtime: {
                post: input.post ?? (async () => undefined),
                shutdown: input.shutdown ?? (async () => undefined),
              },
            })),
        }),
  };
  return { commands, dependencies, secrets, readModel: () => model, readSettings: () => settings };
}

const telegramConnect = (botId: BotId, token = "telegram-token") => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-${botId}`),
  botId,
  provider: "telegram" as const,
  token,
});

const imessageConnect = (botId: BotId) => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-imessage-${botId}`),
  botId,
  provider: "imessage" as const,
  mode: "hosted" as const,
  projectId: "photon-project",
  projectSecret: "photon-secret",
});

const whatsappConnect = (botId: BotId) => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-whatsapp-${botId}`),
  botId,
  provider: "whatsapp" as const,
  accessToken: "access-token",
  appSecret: "app-secret",
  phoneNumberId: "phone-number-id",
  verifyToken: "verify-token",
});

const signedWhatsAppRequest = (body: string) =>
  new Request(`https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", "app-secret").update(body).digest("hex")}`,
    },
    body,
  });

afterEach(async () => {
  await shutdownAllChannels();
  photon.adapter = null;
  photon.chat = null;
  photon.failedSubscription = null;
  photon.subscriptionAttempts.length = 0;
});

describe("channel runtime", () => {
  it("gives each external conversation a stable isolated thread", () => {
    const first = channelThreadId(BOT_ID, "telegram", "telegram:123");

    expect(channelThreadId(BOT_ID, "telegram", "telegram:123")).toBe(first);
    expect(channelThreadId(BOT_ID, "telegram", "telegram:456")).not.toBe(first);
    expect(channelThreadId(BOT_ID, "imessage", "telegram:123")).not.toBe(first);
  });

  it("preserves the inbound provider, thread, and sender on the turn command", async () => {
    const harness = makeHarness({});

    await dispatchInboundChannelMessage(harness.dependencies, {
      botId: BOT_ID,
      provider: "telegram",
      externalThreadId: "chat-a",
      externalSenderId: "sender-7",
      text: "Hello",
    });

    const turn = harness.commands.find((command) => command.type === "thread.turn.start");
    expect(turn?.type).toBe("thread.turn.start");
    if (turn?.type !== "thread.turn.start") throw new Error("Expected a turn command.");
    expect(turn.message.channelOrigin).toEqual({
      provider: "telegram",
      externalThreadId: "chat-a",
      externalSenderId: "sender-7",
    });
  });

  it("verifies WhatsApp webhook challenges", async () => {
    const harness = makeHarness({ startTransport: null });
    await connectChannel(harness.dependencies, whatsappConnect(BOT_ID));

    const accepted = await handleWhatsAppWebhook(
      BOT_ID,
      new Request(
        `https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=challenge-123`,
      ),
    );
    const rejected = await handleWhatsAppWebhook(
      BOT_ID,
      new Request(
        `https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123`,
      ),
    );

    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("challenge-123");
    expect(rejected.status).toBe(403);
  });

  it("validates and dispatches inbound WhatsApp DMs", async () => {
    const harness = makeHarness({ startTransport: null });
    await connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "business-id",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+15550001111",
                  phone_number_id: "phone-number-id",
                },
                contacts: [{ profile: { name: "Alice" }, wa_id: "15551234567" }],
                messages: [
                  {
                    from: "15551234567",
                    id: "wamid.1",
                    timestamp: "1788220000",
                    text: { body: "Hello from WhatsApp" },
                    type: "text",
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const invalidSignature = await handleWhatsAppWebhook(
      BOT_ID,
      new Request(`https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook`, {
        method: "POST",
        body: payload,
      }),
    );
    const invalidPayload = await handleWhatsAppWebhook(BOT_ID, signedWhatsAppRequest("{}"));
    const accepted = await handleWhatsAppWebhook(BOT_ID, signedWhatsAppRequest(payload));

    expect(invalidSignature.status).toBe(401);
    expect(invalidPayload.status).toBe(400);
    expect(accepted.status).toBe(200);
    const turn = harness.commands.find((command) => command.type === "thread.turn.start");
    expect(turn?.type).toBe("thread.turn.start");
    if (turn?.type !== "thread.turn.start") throw new Error("Expected a turn command.");
    expect(turn.message.channelOrigin).toEqual({
      provider: "whatsapp",
      externalThreadId: "whatsapp:phone-number-id:15551234567",
      externalSenderId: "15551234567",
    });
  });

  it("keeps DMs automatic and requires the exact bot mention in iMessage groups", async () => {
    let directMessage:
      | Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[1]
      | undefined;
    let transportContext:
      | Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[2]
      | undefined;
    const harness = makeHarness({
      bots: [makeBot(BOT_ID, { name: "Build Bot" })],
      startTransport: async (_input, onDirectMessage, context) => {
        directMessage = onDirectMessage;
        transportContext = context;
        return {
          externalIdentity: "Photon hosted",
          runtime: { post: async () => undefined, shutdown: async () => undefined },
        };
      },
    });
    await connectChannel(harness.dependencies, imessageConnect(BOT_ID));

    await directMessage?.({
      externalThreadId: "imessage:iMessage;-;+15551234567",
      externalSenderId: "+15551234567",
      text: "DM without a mention",
    });
    await transportContext?.onIMessageGroupMessage({
      externalThreadId: "imessage:opaque-family-chat",
      externalSenderId: "+15557654321",
      text: "Build Bot should ignore this",
    });
    await transportContext?.onIMessageGroupMessage({
      externalThreadId: "imessage:opaque-family-chat",
      externalSenderId: "+15557654321",
      text: "@Build Botany should also be ignored",
    });

    expect(harness.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
      1,
    );

    await transportContext?.onIMessageGroupMessage({
      externalThreadId: "imessage:opaque-family-chat",
      externalSenderId: "+15557654321",
      text: "@build bot check the build",
    });

    const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
    expect(turns).toHaveLength(2);
    expect(
      harness.commands.find(
        (command) => command.type === "thread.create" && command.threadId === turns[1]?.threadId,
      ),
    ).toMatchObject({ botId: BOT_ID, groupId: null });
    expect(turns[1]?.message.channelOrigin).toEqual({
      provider: "imessage",
      externalThreadId: "imessage:opaque-family-chat",
      externalSenderId: "+15557654321",
    });
    expect(turns[1]?.message.text).toBe(
      [
        "+15557654321: Build Bot should ignore this",
        "+15557654321: @Build Botany should also be ignored",
        "+15557654321: @build bot check the build",
      ].join("\n"),
    );

    await transportContext?.onIMessageGroupMessage({
      externalThreadId: "imessage:opaque-family-chat",
      externalSenderId: "+15557654321",
      text: "@build bot check again",
    });

    const turnsAfterSecondMention = harness.commands.filter(
      (command) => command.type === "thread.turn.start",
    );
    expect(turnsAfterSecondMention.map((turn) => turn.message.text)).toEqual([
      "DM without a mention",
      turns[1]?.message.text,
      "@build bot check again",
    ]);
  });

  it("keeps recent iMessage context separate by group", async () => {
    let transportContext:
      | Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[2]
      | undefined;
    const harness = makeHarness({
      bots: [makeBot(BOT_ID, { name: "Build Bot" })],
      startTransport: async (_input, _onDirectMessage, context) => {
        transportContext = context;
        return {
          externalIdentity: "Photon hosted",
          runtime: { post: async () => undefined, shutdown: async () => undefined },
        };
      },
    });
    await connectChannel(harness.dependencies, imessageConnect(BOT_ID));

    await transportContext?.onIMessageGroupMessage({
      externalThreadId: "imessage:group-a",
      externalSenderId: "alice",
      text: "A context",
    });
    await transportContext?.onIMessageGroupMessage({
      externalThreadId: "imessage:group-b",
      externalSenderId: "bob",
      text: "B context",
    });
    await transportContext?.onIMessageGroupMessage({
      externalThreadId: "imessage:group-a",
      externalSenderId: "carol",
      text: "@build bot answer A",
    });
    await transportContext?.onIMessageGroupMessage({
      externalThreadId: "imessage:group-b",
      externalSenderId: "dave",
      text: "@build bot answer B",
    });

    const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
    expect(turns.map((turn) => turn.message.text)).toEqual([
      "alice: A context\ncarol: @build bot answer A",
      "bob: B context\ndave: @build bot answer B",
    ]);
    expect(turns.map((turn) => turn.message.channelOrigin?.externalThreadId)).toEqual([
      "imessage:group-a",
      "imessage:group-b",
    ]);
  });

  it("bounds buffered iMessage group chatter", async () => {
    let transportContext:
      | Parameters<NonNullable<ChannelRuntimeDependencies["startTransport"]>>[2]
      | undefined;
    const harness = makeHarness({
      bots: [makeBot(BOT_ID, { name: "Build Bot" })],
      startTransport: async (_input, _onDirectMessage, context) => {
        transportContext = context;
        return {
          externalIdentity: "Photon hosted",
          runtime: { post: async () => undefined, shutdown: async () => undefined },
        };
      },
    });
    await connectChannel(harness.dependencies, imessageConnect(BOT_ID));

    for (let index = 0; index < 21; index += 1) {
      await transportContext?.onIMessageGroupMessage({
        externalThreadId: "imessage:busy-group",
        externalSenderId: "alice",
        text: `context ${index}`,
      });
    }
    await transportContext?.onIMessageGroupMessage({
      externalThreadId: "imessage:busy-group",
      externalSenderId: "bob",
      text: "@build bot summarize",
    });

    const turn = harness.commands.find((command) => command.type === "thread.turn.start");
    expect(turn?.type).toBe("thread.turn.start");
    if (turn?.type !== "thread.turn.start") throw new Error("Expected a turn command.");
    expect(turn.message.text).not.toContain("context 0\n");
    expect(turn.message.text.split("\n")).toHaveLength(21);
  });

  it("routes initial and subscribed iMessage group mentions through Chat SDK", async () => {
    const groupId = "imessage:opaque-group";
    const harness = makeHarness({
      bots: [makeBot(BOT_ID, { name: "Build Bot" })],
      startTransport: null,
    });
    await connectChannel(harness.dependencies, imessageConnect(BOT_ID));
    if (!photon.chat || !photon.adapter) throw new Error("Expected the Photon Chat runtime.");

    await photon.chat.processMessage(
      photon.adapter,
      groupId,
      makeChatSdkMessage(groupId, "group-1", "@build bot status", "+15551110000"),
    );
    await photon.chat.processMessage(
      photon.adapter,
      groupId,
      makeChatSdkMessage(groupId, "group-2", "background chatter", "+15552220000"),
    );
    await photon.chat.processMessage(
      photon.adapter,
      groupId,
      makeChatSdkMessage(groupId, "group-2b", "@Build Bot-dev ignore", "+15552220000"),
    );
    await photon.chat.processMessage(
      photon.adapter,
      groupId,
      makeChatSdkMessage(groupId, "group-3", "@BUILD BOT continue", "+15552220000"),
    );

    const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
    expect(turns).toHaveLength(2);
    expect(photon.subscriptionAttempts).toEqual([groupId]);
    expect(turns.map((turn) => turn.message.text)).toEqual([
      "@build bot status",
      "+15552220000: background chatter\n+15552220000: @Build Bot-dev ignore\n+15552220000: @BUILD BOT continue",
    ]);
  });

  it("restores durable iMessage group subscriptions for the bot channel", async () => {
    const groupId = "imessage:opaque-release-team";
    const badGroupId = "imessage:stale-release-team";
    const threadId = channelThreadId(BOT_ID, "imessage", groupId);
    const badThreadId = channelThreadId(BOT_ID, "imessage", badGroupId);
    const harness = makeHarness({
      startTransport: null,
      threads: [
        makeThread(threadId, BOT_ID, [
          makeMessage(MessageId.make("group-inbound"), "user", "@Build Bot status", {
            provider: "imessage",
            externalThreadId: groupId,
            externalSenderId: "+15552223333",
          }),
        ]),
        makeThread(badThreadId, BOT_ID, [
          makeMessage(MessageId.make("bad-group-inbound"), "user", "@Build Bot status", {
            provider: "imessage",
            externalThreadId: badGroupId,
            externalSenderId: "+15553334444",
          }),
        ]),
      ],
    });
    photon.failedSubscription = badGroupId;

    await connectChannel(harness.dependencies, imessageConnect(BOT_ID));
    await stopChannelsForBot(BOT_ID);
    await expect(restoreConnectedChannels(harness.dependencies)).resolves.toEqual([]);

    expect(photon.subscriptionAttempts.filter((id) => id === groupId)).toHaveLength(2);
    expect(photon.subscriptionAttempts.filter((id) => id === badGroupId)).toHaveLength(2);
  });

  it("replies to the same iMessage group GUID", async () => {
    const groupId = "imessage:iMessage;+;project-chat~+15550001111";
    const messageId = MessageId.make("group-reply");
    const threadId = channelThreadId(BOT_ID, "imessage", groupId);
    const posts: Array<{ readonly externalThreadId: string; readonly text: string }> = [];
    const harness = makeHarness({
      threads: [
        makeThread(threadId, BOT_ID, [
          makeMessage(MessageId.make("group-question"), "user", "@bot-1 status", {
            provider: "imessage",
            externalThreadId: groupId,
            externalSenderId: "+15554445555",
          }),
          makeMessage(messageId, "assistant", "Build is green"),
        ]),
      ],
      post: async (externalThreadId, text) => void posts.push({ externalThreadId, text }),
    });
    await connectChannel(harness.dependencies, imessageConnect(BOT_ID));

    await sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });

    expect(posts).toEqual([{ externalThreadId: groupId, text: "Build is green" }]);
  });

  it("rejects inbound messages for archived bots", async () => {
    const harness = makeHarness({ bots: [makeBot(BOT_ID, { archivedAt: NOW })] });

    await expect(
      dispatchInboundChannelMessage(harness.dependencies, {
        botId: BOT_ID,
        provider: "telegram",
        externalThreadId: "chat-a",
        text: "Hello",
      }),
    ).rejects.toThrow("unavailable");
    expect(harness.commands).toEqual([]);
  });

  it("shows connected persisted bindings as needing reconnect until transport starts", () => {
    const binding: ChannelBinding = {
      botId: BOT_ID,
      provider: "telegram",
      status: "connected",
      externalIdentity: "@akeru",
      connectedAt: NOW,
      sentMessageIds: [],
    };

    expect(channelBindingsForRuntime([binding], () => false)).toEqual([
      { ...binding, status: "needs-reconnect" },
    ]);
    expect(channelBindingsForRuntime([binding], () => true)).toEqual([binding]);
  });

  it("rejects archived bot connections and skips them during restore", async () => {
    let starts = 0;
    const binding: ChannelBinding = {
      botId: BOT_ID,
      provider: "telegram",
      status: "connected",
      externalIdentity: "@akeru",
      connectedAt: NOW,
      sentMessageIds: [],
    };
    const harness = makeHarness({
      bots: [makeBot(BOT_ID, { archivedAt: NOW, channelBindings: [binding] })],
      startTransport: async () => {
        starts += 1;
        throw new Error("Transport must not start.");
      },
    });

    await expect(connectChannel(harness.dependencies, telegramConnect(BOT_ID))).rejects.toThrow(
      "unavailable",
    );
    await expect(restoreConnectedChannels(harness.dependencies)).resolves.toEqual([]);
    expect(starts).toBe(0);
  });

  it.effect("stops every live transport on bot archive events without stopping restored bots", () =>
    Effect.gen(function* () {
      let stops = 0;
      const harness = makeHarness({ shutdown: async () => void (stops += 1) });
      yield* Effect.promise(() => connectChannel(harness.dependencies, telegramConnect(BOT_ID)));
      yield* Effect.promise(() => connectChannel(harness.dependencies, imessageConnect(BOT_ID)));
      const eventBase = {
        sequence: 13,
        eventId: EventId.make("event-bot-lifecycle"),
        aggregateKind: "bot" as const,
        aggregateId: BOT_ID,
        occurredAt: NOW,
        commandId: CommandId.make("command-bot-lifecycle"),
        causationEventId: null,
        correlationId: CommandId.make("command-bot-lifecycle"),
        metadata: {},
      };

      yield* stopArchivedBotChannels(
        Stream.make({
          ...eventBase,
          type: "bot.restored",
          payload: { botId: BOT_ID, updatedAt: NOW },
        }),
      );
      expect(stops).toBe(0);

      yield* stopArchivedBotChannels(
        Stream.make({
          ...eventBase,
          type: "bot.archived",
          payload: { botId: BOT_ID, archivedAt: NOW, updatedAt: NOW },
        }),
      );
      expect(stops).toBe(2);
    }),
  );

  it("connects, disconnects, reconnects, restores, and stops a bot runtime", async () => {
    let starts = 0;
    let stops = 0;
    const harness = makeHarness({
      startTransport: async () => {
        starts += 1;
        return {
          externalIdentity: "@akeru",
          runtime: {
            post: async () => undefined,
            shutdown: async () => void (stops += 1),
          },
        };
      },
    });

    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    expect(harness.readModel().bots[0]?.channelBindings?.[0]?.status).toBe("connected");
    await stopChannelsForBot(BOT_ID);
    expect(stops).toBe(1);
    await reconnectChannel(harness.dependencies, BOT_ID, "telegram");
    await stopChannelsForBot(BOT_ID);
    await restoreConnectedChannels(harness.dependencies);
    await disconnectChannel(harness.dependencies, BOT_ID, "telegram");

    expect(starts).toBe(3);
    expect(stops).toBe(3);
    expect(harness.readModel().bots[0]?.channelBindings?.[0]?.status).toBe("disconnected");
    expect(harness.secrets.size).toBe(0);
  });

  it("saves, attaches, reconnects, detaches, and deletes a reusable connection", async () => {
    const connectionId = ChannelConnectionId.make("telegram-main");
    const harness = makeHarness({});

    await saveChannelConnection(harness.dependencies, {
      type: "channel.connection.save",
      commandId: CommandId.make("save-connection"),
      connectionId,
      name: "Main Telegram",
      provider: "telegram",
      token: "telegram-token",
    });
    await attachChannelConnection(harness.dependencies, BOT_ID, connectionId, "telegram");
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

    await expect(
      saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("edit-attached-connection"),
        connectionId,
        name: "Changed Telegram",
        provider: "telegram",
        token: "changed-token",
      }),
    ).rejects.toThrow("Disconnect this channel before editing it");

    await expect(deleteChannelConnection(harness.dependencies, connectionId)).rejects.toThrow(
      "Disconnect this channel",
    );
    await stopChannelsForBot(BOT_ID);
    await reconnectChannel(harness.dependencies, BOT_ID, "telegram");
    await disconnectChannel(harness.dependencies, BOT_ID, "telegram");
    await expect(reconnectChannel(harness.dependencies, BOT_ID, "telegram")).rejects.toThrow(
      "No active telegram channel",
    );
    expect(harness.secrets.size).toBe(1);
    await deleteChannelConnection(harness.dependencies, connectionId);
    expect(harness.secrets.size).toBe(0);
    expect(harness.readSettings().channelConnections).toEqual([]);
  });

  it("serializes multiple reusable connection profiles", async () => {
    const telegramId = ChannelConnectionId.make("telegram-work");
    const photonId = ChannelConnectionId.make("photon-personal");
    const harness = makeHarness({});

    await Promise.all([
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
    ]);

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
  });

  it("stores a safe dashboard link for hosted Photon", async () => {
    const connectionId = ChannelConnectionId.make("photon-hosted");
    const harness = makeHarness({});

    await saveChannelConnection(harness.dependencies, {
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
    expect(JSON.stringify(harness.readSettings().channelConnections)).not.toContain(
      "never-in-settings",
    );
  });

  it("rolls back a saved secret when profile persistence fails", async () => {
    const connectionId = ChannelConnectionId.make("failed-profile");
    const harness = makeHarness({
      settings: {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () => Effect.die(new Error("settings write failed")),
      },
    });

    await expect(
      saveChannelConnection(harness.dependencies, {
        type: "channel.connection.save",
        commandId: CommandId.make("save-failed-profile"),
        connectionId,
        name: "Failed profile",
        provider: "telegram",
        token: "telegram-token",
      }),
    ).rejects.toThrow("settings write failed");
    expect(harness.secrets.size).toBe(0);
  });

  it("restores saved WhatsApp credentials", async () => {
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

    await connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
    await stopChannelsForBot(BOT_ID);
    await restoreConnectedChannels(harness.dependencies);

    expect(starts).toBe(2);
  });

  it("sends an approved WhatsApp reply to the inbound DM", async () => {
    const messageId = MessageId.make("whatsapp-reply");
    const externalThreadId = "whatsapp:phone-number-id:15551234567";
    const threadId = channelThreadId(BOT_ID, "whatsapp", externalThreadId);
    const posts: Array<{ readonly externalThreadId: string; readonly text: string }> = [];
    const harness = makeHarness({
      threads: [
        makeThread(threadId, BOT_ID, [
          makeMessage(MessageId.make("whatsapp-inbound"), "user", "Question", {
            provider: "whatsapp",
            externalThreadId,
            externalSenderId: "15551234567",
          }),
          makeMessage(messageId, "assistant", "Approved answer"),
        ]),
      ],
      post: async (target, text) => void posts.push({ externalThreadId: target, text }),
    });
    await connectChannel(harness.dependencies, whatsappConnect(BOT_ID));

    await sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId });

    expect(posts).toEqual([{ externalThreadId, text: "Approved answer" }]);
  });

  it("automatically sends one completed reply for an inbound channel turn", async () => {
    const turnId = TurnId.make("turn-auto-reply");
    const requestMessageId = MessageId.make("inbound-auto-reply");
    const messageId = MessageId.make("assistant-auto-reply");
    const threadId = ThreadId.make("thread-auto-reply");
    let posts = 0;
    const thread: OrchestrationThread = {
      ...makeThread(threadId, BOT_ID, [
        makeMessage(requestMessageId, "user", "Hello", {
          provider: "imessage",
          externalThreadId: "iMessage;-;sender",
        }),
        { ...makeMessage(messageId, "assistant", "Hello back"), turnId },
      ]),
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: messageId,
        requestMessageId,
        respondingBotId: BOT_ID,
      },
    };
    const harness = makeHarness({
      threads: [thread],
      post: async () => void (posts += 1),
    });
    await connectChannel(harness.dependencies, imessageConnect(BOT_ID));

    await expect(
      sendCompletedChannelReply(harness.dependencies, threadId, turnId),
    ).resolves.toBeGreaterThan(0);
    await expect(
      sendCompletedChannelReply(harness.dependencies, threadId, turnId),
    ).resolves.toBeGreaterThan(0);

    expect(posts).toBe(1);
    expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toContain(messageId);

    await expect(
      sendCompletedChannelReply(
        harness.dependencies,
        threadId,
        TurnId.make("stale-auto-reply-turn"),
      ),
    ).resolves.toBeNull();
    expect(posts).toBe(1);
  });

  it("does not send a local turn to an earlier channel conversation", async () => {
    const turnId = TurnId.make("turn-local-after-channel");
    const inboundMessageId = MessageId.make("inbound-before-local-turn");
    const localMessageId = MessageId.make("local-request");
    const assistantMessageId = MessageId.make("local-assistant");
    const threadId = ThreadId.make("thread-local-after-channel");
    let posts = 0;
    const thread: OrchestrationThread = {
      ...makeThread(threadId, BOT_ID, [
        makeMessage(inboundMessageId, "user", "Channel question", {
          provider: "imessage",
          externalThreadId: "iMessage;-;sender",
        }),
        makeMessage(localMessageId, "user", "Local question"),
        { ...makeMessage(assistantMessageId, "assistant", "Local answer"), turnId },
      ]),
      latestTurn: {
        turnId,
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId,
        requestMessageId: localMessageId,
        respondingBotId: BOT_ID,
      },
    };
    const harness = makeHarness({
      threads: [thread],
      post: async () => void (posts += 1),
    });
    await connectChannel(harness.dependencies, imessageConnect(BOT_ID));

    await expect(
      sendCompletedChannelReply(harness.dependencies, threadId, turnId),
    ).resolves.toBeNull();

    expect(posts).toBe(0);
  });

  it("uses collision-free secret names for distinct bot IDs", async () => {
    const firstId = BotId.make("sales/east");
    const secondId = BotId.make("sales?east");
    const harness = makeHarness({ bots: [makeBot(firstId), makeBot(secondId)] });

    await connectChannel(harness.dependencies, telegramConnect(firstId, "token-1"));
    await connectChannel(harness.dependencies, telegramConnect(secondId, "token-2"));

    expect(harness.secrets.size).toBe(2);
    expect([...harness.secrets.keys()].every((name) => !name.includes("sales"))).toBe(true);
  });

  it("stops a new transport when reading the previous secret fails", async () => {
    const { store } = makeMemorySecretStore();
    let stops = 0;
    const harness = makeHarness({
      secretStore: { ...store, get: () => Effect.die(new Error("secret read failed")) },
      shutdown: async () => void (stops += 1),
    });

    await expect(connectChannel(harness.dependencies, telegramConnect(BOT_ID))).rejects.toThrow(
      "secret read failed",
    );

    expect(stops).toBe(1);
    expect(harness.readModel().bots[0]?.channelBindings).toEqual([]);
  });

  it("keeps a connected runtime when removing its secret fails", async () => {
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
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    failRemove = true;

    await expect(disconnectChannel(harness.dependencies, BOT_ID, "telegram")).rejects.toThrow(
      "secret remove failed",
    );

    const binding = harness.readModel().bots[0]?.channelBindings?.[0];
    expect(binding?.status).toBe("connected");
    expect(binding && channelBindingsForRuntime([binding])).toEqual([binding]);
    expect(values.size).toBe(1);
    expect(stops).toBe(0);
  });

  it("rejects one Telegram token bound to two active bots", async () => {
    const secondId = BotId.make("bot-2");
    const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));
    await expect(connectChannel(harness.dependencies, telegramConnect(secondId))).rejects.toThrow(
      "already connected",
    );
  });

  it("rejects one WhatsApp number bound to two active bots", async () => {
    const secondId = BotId.make("bot-2");
    const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

    await connectChannel(harness.dependencies, whatsappConnect(BOT_ID));
    await expect(connectChannel(harness.dependencies, whatsappConnect(secondId))).rejects.toThrow(
      "already connected",
    );
  });

  it("serializes concurrent WhatsApp identity claims", async () => {
    const secondId = BotId.make("bot-2");
    const harness = makeHarness({ bots: [makeBot(BOT_ID), makeBot(secondId)] });

    const results = await Promise.allSettled([
      connectChannel(harness.dependencies, whatsappConnect(BOT_ID)),
      connectChannel(harness.dependencies, whatsappConnect(secondId)),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      harness
        .readModel()
        .bots.flatMap((bot) => bot.channelBindings ?? [])
        .filter((binding) => binding.provider === "whatsapp" && binding.status === "connected"),
    ).toHaveLength(1);
  });

  it("releases a failed post so explicit approval can retry", async () => {
    const messageId = MessageId.make("message-retry");
    const threadId = ThreadId.make("thread-retry");
    let posts = 0;
    const harness = makeHarness({
      threads: [
        makeThread(threadId, BOT_ID, [
          makeMessage(MessageId.make("inbound"), "user", "Question", {
            provider: "telegram",
            externalThreadId: "chat-retry",
          }),
          makeMessage(messageId, "assistant", "Retry me"),
        ]),
      ],
      post: async () => {
        posts += 1;
        if (posts === 1) throw new Error("transport unavailable");
      },
    });
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));

    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("transport unavailable");
    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).resolves.toBeGreaterThan(0);
    expect(posts).toBe(2);
  });

  it("does not mark or repost an unresolved failed delivery", async () => {
    const messageId = MessageId.make("message-release-failed");
    const threadId = ThreadId.make("thread-release-failed");
    let status: "requested" | "sent" | undefined;
    let posts = 0;
    let marks = 0;
    const deliveryStore: ChannelRuntimeDependencies["deliveryStore"] = {
      claim: () =>
        Effect.sync(() => {
          if (status) return status;
          status = "requested";
          return "claimed";
        }),
      releaseRequested: () => Effect.die(new Error("release failed")),
      markSent: () => Effect.sync(() => void (marks += 1)),
    };
    const harness = makeHarness({
      deliveryStore,
      threads: [
        makeThread(threadId, BOT_ID, [
          makeMessage(MessageId.make("inbound-release"), "user", "Question", {
            provider: "telegram",
            externalThreadId: "chat-release",
          }),
          makeMessage(messageId, "assistant", "Do not mark me sent"),
        ]),
      ],
      post: async () => {
        posts += 1;
        throw new Error("post failed");
      },
    });
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));

    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("release failed");
    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("unfinished delivery attempt");

    expect(posts).toBe(1);
    expect(marks).toBe(0);
  });

  it("does not repost after transport succeeds and mark-sent fails", async () => {
    const messageId = MessageId.make("message-mark-sent-retry");
    const threadId = ThreadId.make("thread-mark-sent-retry");
    let deliveryStatus: "requested" | "sent" | undefined;
    let markAttempts = 0;
    let posts = 0;
    const deliveryStore: ChannelRuntimeDependencies["deliveryStore"] = {
      claim: () =>
        Effect.sync(() => {
          if (deliveryStatus) return deliveryStatus;
          deliveryStatus = "requested";
          return "claimed";
        }),
      releaseRequested: () => Effect.sync(() => void (deliveryStatus = undefined)),
      markSent: () =>
        Effect.sync(() => {
          markAttempts += 1;
          if (markAttempts === 1) throw new Error("database unavailable");
          deliveryStatus = "sent";
        }),
    };
    const harness = makeHarness({
      deliveryStore,
      threads: [
        makeThread(threadId, BOT_ID, [
          makeMessage(MessageId.make("inbound-mark"), "user", "Question", {
            provider: "telegram",
            externalThreadId: "chat-mark",
          }),
          makeMessage(messageId, "assistant", "Send once"),
        ]),
      ],
      post: async () => void (posts += 1),
    });
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));

    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("database unavailable");
    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).resolves.toBeGreaterThan(0);
    expect(posts).toBe(1);
    expect(markAttempts).toBe(2);
  });

  it("fills the sent binding on retry after binding persistence fails", async () => {
    const messageId = MessageId.make("message-binding-retry");
    const threadId = ThreadId.make("thread-binding-retry");
    let posts = 0;
    const harness = makeHarness({
      failBotUpdate: (updateIndex) =>
        updateIndex === 2 ? new Error("binding persistence failed") : undefined,
      threads: [
        makeThread(threadId, BOT_ID, [
          makeMessage(MessageId.make("inbound-binding"), "user", "Question", {
            provider: "telegram",
            externalThreadId: "chat-binding",
          }),
          makeMessage(messageId, "assistant", "Send once and recover"),
        ]),
      ],
      post: async () => void (posts += 1),
    });
    await connectChannel(harness.dependencies, telegramConnect(BOT_ID));

    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).rejects.toThrow("binding persistence failed");
    await expect(
      sendChannelMessage(harness.dependencies, { botId: BOT_ID, threadId, messageId }),
    ).resolves.toBeGreaterThan(0);

    expect(posts).toBe(1);
    expect(harness.readModel().bots[0]?.channelBindings[0]?.sentMessageIds).toContain(messageId);
  });
});
