import {
  BOT_ID,
  NOW,
  connectChannel,
  externalAdapters,
  makeBot,
  makeHarness,
  slackConnect,
} from "./channelRuntime.ts";
import { BotId, type ChannelOwnerIdentity } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Slack Socket Mode events and a connected Slack bot for the channel access tests. */
const THREAD_TS = "1710000000.000100";

const THREAD = `slack:C1:${THREAD_TS}`;

const OTHER_BOT_ID = BotId.make("bot-2");

const owner = (userId: string, workspaceId = "T-HOME"): ChannelOwnerIdentity => ({
  provider: "slack",
  workspaceId,
  userId,
  displayName: "Leo",
  linkedAt: NOW,
});

const atOffset = (milliseconds: number) => new Date(Date.parse(NOW) + milliseconds).toISOString();

const HOUR = 60 * 60 * 1000;

type SlackEvent = Record<string, string>;

const mention = (ts: string, user: string, text: string, extra: SlackEvent = {}) => ({
  type: "app_mention",
  channel: "C1",
  channel_type: "channel",
  user,
  text,
  ts,
  ...extra,
});

const threadReply = (ts: string, user: string, text: string, extra: SlackEvent = {}) => ({
  type: "message",
  channel: "C1",
  channel_type: "channel",
  user,
  text,
  ts,
  thread_ts: THREAD_TS,
  ...extra,
});

const directMessage = (ts: string, user: string, text: string, extra: SlackEvent = {}) => ({
  type: "message",
  channel: "D1",
  channel_type: "im",
  user,
  text,
  ts,
  ...extra,
});

/** Delivers one Socket Mode event through the adapter's own event pipeline and waits for it. */
const deliverEvent = async <Event extends object>(
  event: Event,
  eventId: string,
  retryNum?: number,
) => {
  const adapter = externalAdapters.slackAdapter;

  if (!adapter) throw new Error("Expected the Slack adapter.");
  const tasks: Array<Promise<unknown>> = [];

  const request = new Request("https://akeru.example/slack", {
    method: "POST",
    headers: { "x-slack-socket-token": "xapp-token" },
    body: JSON.stringify({
      eventType: "events_api",
      body: { event, team_id: "T-HOME", event_id: eventId },
      ...(retryNum ? { retryNum } : {}),
    }),
  });

  const response = await adapter.handleWebhook(request, {
    waitUntil: (task) => void tasks.push(task),
  });

  await Promise.all(tasks);

  if (response.status !== 200) throw new Error(`Slack event rejected: ${response.status}`);
};

const deliver = <Event extends object>(event: Event, eventId: string, retryNum?: number) =>
  Effect.promise(() => deliverEvent(event, eventId, retryNum));

const decodePostBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ text: Schema.String })),
);

const acceptPosts = (count: number) => {
  for (let index = 0; index < count; index += 1) {
    externalAdapters.slackResponses.push({ status: 200, data: { ok: true, ts: `9.${index}` } });
  }
};

const postedTexts = () =>
  externalAdapters.slackApiCalls.flatMap((call) => {
    if (!call.url.endsWith("chat.postMessage")) return [];

    const text = call.data.startsWith("{")
      ? Option.getOrUndefined(decodePostBody(call.data))?.text
      : new URLSearchParams(call.data).get("text");

    return [text ?? ""];
  });

const historyReads = () =>
  externalAdapters.slackApiCalls.filter((call) => call.url.endsWith("conversations.replies"))
    .length;

const setup = (
  input: {
    readonly owners?: ReadonlyArray<ChannelOwnerIdentity>;
    readonly allowedUserIds?: ReadonlyArray<string>;
    readonly replyToOthers?: boolean;
    readonly now?: () => string;
    readonly wrapFollowStore?: Parameters<typeof makeHarness>[0]["wrapFollowStore"];
  } = {},
) =>
  Effect.gen(function* () {
    const harness = makeHarness({
      startTransport: null,
      bots: [
        makeBot(BOT_ID, { name: "Scout" }),
        makeBot(OTHER_BOT_ID, {
          channelBindings: [
            {
              botId: OTHER_BOT_ID,
              provider: "slack",
              status: "connected",
              externalIdentity: "U0OTHER",
              connectedAt: NOW,
              sentMessageIds: [],
            },
          ],
        }),
      ],
      channelOwners: input.owners ?? [owner("U-LEO")],
      channelBotAccess:
        input.allowedUserIds || input.replyToOthers
          ? [
              {
                botId: BOT_ID,
                allowedUserIds: input.allowedUserIds ?? [],
                replyToOthers: input.replyToOthers ?? false,
              },
            ]
          : [],
      ...(input.now ? { now: input.now } : {}),
      ...(input.wrapFollowStore ? { wrapFollowStore: input.wrapFollowStore } : {}),
    });

    yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));

    const turns = () =>
      harness.commands.flatMap((command) =>
        command.type === "thread.turn.start" ? [command] : [],
      );

    return { harness, turns };
  });

export {
  THREAD_TS,
  THREAD,
  OTHER_BOT_ID,
  owner,
  atOffset,
  HOUR,
  mention,
  threadReply,
  directMessage,
  deliver,
  deliverEvent,
  acceptPosts,
  postedTexts,
  historyReads,
  setup,
};
