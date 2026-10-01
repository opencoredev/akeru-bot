type SlackRetryOptions = {
  retries?: number | undefined;
  rejectRateLimitedCalls?: boolean | undefined;
};

import type { iMessageAdapter } from "@photon-ai/chat-adapter-imessage";
import { type Adapter, type ChatInstance } from "chat";
import { vi } from "vite-plus/test";

const photon = vi.hoisted(() => ({
  adapter: null as iMessageAdapter | null,
  chat: null as ChatInstance | null,
  failedSubscription: null as string | null,
  gatewayError: null as Error | null,
  gatewayStatus: 200,
  subscriptionAttempts: [] as string[],
}));

const externalAdapters = vi.hoisted(() => ({
  slackAdapter: null as Adapter | null,
  slackChat: null as ChatInstance | null,
  slackDisconnects: 0,
  slackIdentityAvailable: true,
  slackInitializationFails: false,
  slackSubscriptions: [] as string[],
  slackRestoredBeforeInitialize: false,
  slackResponses: [] as Array<
    { status: number; data: unknown; headers?: Record<string, string> } | Error
  >,
  slackPostRequests: 0,
  slackRetryOptions: {} as SlackRetryOptions,
  discordAdapter: null as Adapter | null,
  discordChat: null as ChatInstance | null,
  discordGatewayStarts: 0,
  discordIdentityFails: false,
  discordDisconnects: 0,
  discordSubscriptions: [] as string[],
  reactions: [] as string[],
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

      adapter.startGatewayListener = async ({ waitUntil }, _durationMs, signal) => {
        if (photon.gatewayError) throw photon.gatewayError;
        waitUntil?.(
          new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        );

        return new Response(null, { status: photon.gatewayStatus });
      };

      adapter.onThreadSubscribe = async (threadId) => {
        photon.subscriptionAttempts.push(threadId);

        if (threadId === photon.failedSubscription) throw new Error("invalid group GUID");
      };

      adapter.disconnect = async () => undefined;

      return adapter;
    },
  };
});

vi.mock("@chat-adapter/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chat-adapter/slack")>();

  return {
    ...actual,
    createSlackAdapter: (options: Parameters<typeof actual.createSlackAdapter>[0] = {}) => {
      externalAdapters.slackRetryOptions = {
        retries: options.webClientOptions?.retryConfig?.retries,
        rejectRateLimitedCalls: options.webClientOptions?.rejectRateLimitedCalls,
      };

      const adapter = actual.createSlackAdapter({
        ...options,
        webClientOptions: {
          ...options.webClientOptions,
          adapter: async (config) => {
            if (config.url !== "https://slack.com/api/chat.postMessage") {
              throw new Error("Unexpected Slack API request");
            }

            externalAdapters.slackPostRequests += 1;
            const response = externalAdapters.slackResponses.shift();

            if (response instanceof Error) throw response;

            if (!response) throw new Error("Missing Slack API response");

            return {
              ...response,
              headers: response.headers ?? {},
              statusText: "",
              config,
              request: { path: "/api/chat.postMessage" },
            };
          },
        },
      }) as ReturnType<typeof actual.createSlackAdapter> & Adapter;

      adapter.initialize = async (chat) => {
        if (externalAdapters.slackIdentityAvailable) {
          Object.assign(adapter, { _botUserId: "U-AKERU" });
        }

        externalAdapters.slackAdapter = adapter;
        externalAdapters.slackChat = chat;
        externalAdapters.slackRestoredBeforeInitialize = await chat
          .getState()
          .isSubscribed("slack:C1:1");

        if (externalAdapters.slackInitializationFails) throw new Error("Socket startup failed");
      };

      adapter.addReaction = async (threadId, messageId, emoji) => {
        externalAdapters.reactions.push(`add:${threadId}:${messageId}:${String(emoji)}`);
      };

      adapter.removeReaction = async (threadId, messageId, emoji) => {
        externalAdapters.reactions.push(`remove:${threadId}:${messageId}:${String(emoji)}`);
      };

      adapter.onThreadSubscribe = async (threadId) => {
        externalAdapters.slackSubscriptions.push(threadId);
      };

      adapter.disconnect = async () => {
        externalAdapters.slackDisconnects += 1;
      };

      return adapter;
    },
  };
});

vi.mock("@chat-adapter/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chat-adapter/discord")>();

  return {
    ...actual,
    createDiscordAdapter: (options: Parameters<typeof actual.createDiscordAdapter>[0]) => {
      const adapter = actual.createDiscordAdapter(options) as ReturnType<
        typeof actual.createDiscordAdapter
      > &
        Adapter;

      adapter.initialize = async (chat) => {
        externalAdapters.discordAdapter = adapter;
        externalAdapters.discordChat = chat;
      };

      adapter.getUser = async (userId) => {
        if (externalAdapters.discordIdentityFails) throw new Error("Discord identity failed");

        return { userId, userName: "akeru-discord", fullName: "Akeru Discord", isBot: true };
      };

      adapter.disconnect = async () => {
        externalAdapters.discordDisconnects += 1;
      };

      adapter.addReaction = async (threadId, messageId, emoji) => {
        externalAdapters.reactions.push(`add:${threadId}:${messageId}:${String(emoji)}`);
      };

      adapter.removeReaction = async (threadId, messageId, emoji) => {
        externalAdapters.reactions.push(`remove:${threadId}:${messageId}:${String(emoji)}`);
      };

      adapter.onThreadSubscribe = async (threadId) => {
        externalAdapters.discordSubscriptions.push(threadId);
      };

      adapter.startGatewayListener = async ({ waitUntil }, _durationMs, signal) => {
        externalAdapters.discordGatewayStarts += 1;
        waitUntil?.(
          new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
        );

        return new Response(null, { status: 200 });
      };

      return adapter;
    },
  };
});

export { photon, externalAdapters };
