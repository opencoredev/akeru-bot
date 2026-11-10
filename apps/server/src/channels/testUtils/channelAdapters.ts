/** The Slack Web API reply bodies the mock sends back. */
interface SlackApiReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly needed?: string;
  readonly messages?: ReadonlyArray<Record<string, string>>;
  readonly user_id?: string;
  readonly team_id?: string;
  readonly user?: {
    readonly id: string;
    readonly name: string;
    readonly team_id: string;
    readonly is_stranger?: boolean;
    readonly deleted?: boolean;
    readonly is_restricted?: boolean;
    readonly is_ultra_restricted?: boolean;
    readonly profile: { readonly display_name: string };
  };
}

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
  /** Runs inside the adapter's `initialize`, where the real adapter starts Socket Mode. */
  slackOnInitialize: null as (() => void) | null,
  slackSubscriptions: [] as string[],
  slackRestoredBeforeInitialize: false,
  slackResponses: [] as Array<
    { status: number; data: unknown; headers?: Record<string, string> } | Error
  >,
  slackPostRequests: 0,
  slackTeamId: "T-HOME",
  /** Display names `users.info` returns, by Slack user ID. */
  slackUserNames: {} as Record<string, string>,
  slackUserLookups: 0,
  /** The team `users.info` reports per user ID. Users not listed belong to `T-HOME`. */
  slackUserTeams: {} as Record<string, string>,
  /** User IDs whose `users.info` lookup fails, so membership cannot be confirmed. */
  slackMissingUsers: [] as string[],
  /** The bot token's scopes, sent the way Slack does in `x-oauth-scopes`. Unset sends none. */
  slackScopes: undefined as ReadonlyArray<string> | undefined,
  /** Account flags `users.info` reports per user ID, such as a deactivated or guest account. */
  slackUserFlags: {} as Record<
    string,
    { deleted?: boolean; is_restricted?: boolean; is_ultra_restricted?: boolean }
  >,
  /** The thread history `conversations.replies` returns, as raw Slack messages. */
  slackThreadMessages: [] as Array<Record<string, string>>,
  /** How many upcoming thread subscriptions fail, to simulate a transient Slack error. */
  slackSubscribeFailures: 0,
  /** Every Slack Web API call, with its form or JSON body. */
  slackApiCalls: [] as Array<{ readonly url: string; readonly data: string }>,
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
            externalAdapters.slackApiCalls.push({
              url: config.url ?? "",
              data: String(config.data ?? ""),
            });

            const scopes = externalAdapters.slackScopes;

            const reply = (data: SlackApiReply) => ({
              status: 200,
              data,
              headers: scopes ? { "x-oauth-scopes": scopes.join(",") } : {},
              statusText: "",
              config,
              request: { path: new URL(config.url ?? "https://slack.com").pathname },
            });

            if (config.url === "https://slack.com/api/auth.test") {
              return reply({ ok: true, user_id: "U-AKERU", team_id: externalAdapters.slackTeamId });
            }

            if (config.url === "https://slack.com/api/users.info") {
              externalAdapters.slackUserLookups += 1;
              const userId = new URLSearchParams(String(config.data ?? "")).get("user") ?? "";
              const name = externalAdapters.slackUserNames[userId];
              const teamId = externalAdapters.slackUserTeams[userId] ?? "T-HOME";

              return reply(
                scopes && !scopes.includes("users:read")
                  ? { ok: false, error: "missing_scope", needed: "users:read" }
                  : externalAdapters.slackMissingUsers.includes(userId)
                    ? { ok: false, error: "user_not_found" }
                    : {
                        ok: true,
                        user: {
                          id: userId,
                          name: name ?? userId,
                          team_id: teamId,
                          ...(teamId === "T-HOME" ? {} : { is_stranger: true }),
                          ...externalAdapters.slackUserFlags[userId],
                          profile: { display_name: name ?? "" },
                        },
                      },
              );
            }

            if (config.url === "https://slack.com/api/conversations.replies") {
              return reply({ ok: true, messages: externalAdapters.slackThreadMessages });
            }

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
        // The adapter's own event pipeline needs its Chat instance to route Socket Mode events.
        Object.assign(adapter, { chat });

        if (externalAdapters.slackIdentityAvailable) {
          Object.assign(adapter, { _botUserId: "U-AKERU" });
        }

        externalAdapters.slackAdapter = adapter;
        externalAdapters.slackChat = chat;
        externalAdapters.slackRestoredBeforeInitialize = await chat
          .getState()
          .isSubscribed("slack:C1:1");

        externalAdapters.slackOnInitialize?.();

        if (externalAdapters.slackInitializationFails) throw new Error("Socket startup failed");
      };

      adapter.addReaction = async (threadId, messageId, emoji) => {
        externalAdapters.reactions.push(`add:${threadId}:${messageId}:${String(emoji)}`);
      };

      adapter.removeReaction = async (threadId, messageId, emoji) => {
        externalAdapters.reactions.push(`remove:${threadId}:${messageId}:${String(emoji)}`);
      };

      adapter.onThreadSubscribe = async (threadId) => {
        if (externalAdapters.slackSubscribeFailures > 0) {
          externalAdapters.slackSubscribeFailures -= 1;

          throw new Error("Slack subscription failed");
        }

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
