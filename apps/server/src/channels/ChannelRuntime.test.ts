import {
  BotId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChannelBinding,
  type OrchestrationBot,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { createEmptyReadModel } from "../orchestration/projector.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeMemoryChannelDeliveryStore } from "./ChannelDeliveryStore.ts";
import {
  channelBindingsForRuntime,
  channelThreadId,
  connectChannel,
  disconnectChannel,
  dispatchInboundChannelMessage,
  reconnectChannel,
  restoreConnectedChannels,
  sendChannelMessage,
  shutdownAllChannels,
  stopChannelsForBot,
  type ChannelRuntimeDependencies,
} from "./ChannelRuntime.ts";

const NOW = "2026-08-27T20:00:00.000Z";
const BOT_ID = BotId.make("bot-1");
const PROJECT_ID = ProjectId.make("project-1");

function makeBot(
  id: BotId,
  input: {
    readonly archivedAt?: string | null;
    readonly channelBindings?: ReadonlyArray<ChannelBinding>;
  } = {},
): OrchestrationBot {
  return {
    id,
    name: id,
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
  readonly startTransport?: ChannelRuntimeDependencies["startTransport"];
  readonly failBotUpdate?: (updateIndex: number) => Error | undefined;
}) {
  let model = makeModel(input.bots ?? [makeBot(BOT_ID)]);
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
    deliveryStore: input.deliveryStore ?? makeMemoryChannelDeliveryStore(),
    readModel: async () => ({ ...model, threads }),
    readThread: async (threadId) => threads.find((thread) => thread.id === threadId) ?? null,
    nowIso: async () => NOW,
    randomUuid: async () => `uuid-${commands.length}`,
    startTransport:
      input.startTransport ??
      (async () => ({
        externalIdentity: "@akeru",
        runtime: {
          post: input.post ?? (async () => undefined),
          shutdown: input.shutdown ?? (async () => undefined),
        },
      })),
  };
  return { commands, dependencies, secrets, readModel: () => model };
}

const telegramConnect = (botId: BotId, token = "telegram-token") => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-${botId}`),
  botId,
  provider: "telegram" as const,
  token,
});

afterEach(async () => {
  await shutdownAllChannels();
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
