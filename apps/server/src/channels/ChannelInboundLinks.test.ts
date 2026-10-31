import { createDiscordAdapter, DiscordFormatConverter } from "@chat-adapter/discord";
import { createSlackAdapter, type SlackEvent } from "@chat-adapter/slack";
import { Message } from "chat";
import { describe, expect, it } from "vite-plus/test";
import { makeChatSdkMessage } from "./testUtils/channelRuntime.ts";
import { mentionWithContext, normalizedInboundMessage } from "./ChannelInbound.ts";

const slack = createSlackAdapter({
  mode: "socket",
  botToken: "xoxb-test",
  appToken: "xapp-test",
});

const slackMessage = (ts: string, user: string, text: string) =>
  slack.parseMessage({
    type: "message",
    channel: "C1",
    ts,
    thread_ts: "1710000000.000001",
    user,
    text,
  } satisfies SlackEvent);

const discord = createDiscordAdapter({
  applicationId: "app-test",
  botToken: "discord-test",
  publicKey: "0".repeat(64),
});

const discordHistoryMessage = (id: string, userId: string, content: string) =>
  discord.parseMessage({
    id,
    channel_id: "C1",
    guild_id: "G1",
    type: 0,
    content,
    timestamp: "2026-01-01T00:00:00.000Z",
    edited_timestamp: null,
    attachments: [],
    author: { id: userId, username: userId, global_name: null },
  });

const thread = (recentMessages: ReadonlyArray<Message> = []) => ({
  id: "slack:C1:1710000000.000001",
  recentMessages: [...recentMessages],
  refresh: async () => undefined,
});

describe("inbound channel message text", () => {
  it("keeps the target of a Slack link whose label is shortened", () => {
    const message = slackMessage(
      "1710000000.000002",
      "U1",
      "look at <https://example.com/projects/abc123/really/long|example.com/projects/…> and <https://bare.example.com/x>",
    );

    expect(normalizedInboundMessage(thread(), message).text).toBe(
      "look at example.com/projects/… (https://example.com/projects/abc123/really/long) and https://bare.example.com/x",
    );
  });

  it("writes a Slack link once when its label already is the target", () => {
    const message = slackMessage(
      "1710000000.000003",
      "U1",
      "see <https://example.com/x|example.com/x>, <https://example.com/|example.com>, <https://example.com/docs/|example.com/docs/>, and <https://example.com/report|the report>",
    );

    expect(normalizedInboundMessage(thread(), message).text).toBe(
      "see example.com/x, example.com, example.com/docs/, and the report (https://example.com/report)",
    );
  });

  it("keeps the adapter's original text when no link target is added", () => {
    const original =
      "# Heading\n\n*literal asterisks* and `backticks` [https://example.test/](https://example.test/)";

    const message = makeChatSdkMessage("telegram:1", "m-1", original, "U1");

    expect(normalizedInboundMessage(thread(), message).text).toBe(original);
  });

  it("writes a Slack link once when only a trailing slash differs from its label", () => {
    const message = slackMessage(
      "1710000000.000006",
      "U1",
      "open <https://example.com/|https://example.com> or <https://example.com/a|example.com/a/>",
    );

    expect(normalizedInboundMessage(thread(), message).text).toBe(
      "open https://example.com or example.com/a/",
    );
  });

  it("keeps the markdown a Discord gateway message arrives with", () => {
    const content = [
      "Run this, then read [docs](https://e.com):",
      "```ts",
      "const snake_case = `value`;",
      "```",
      "1. first __step__",
    ].join("\n");

    const message = new Message({
      id: "discord-1",
      threadId: "discord:G1:C1:T1",
      text: content,
      formatted: new DiscordFormatConverter().toAst(content),
      raw: {},
      author: { userId: "D1", userName: "d1", fullName: "D1", isBot: false, isMe: false },
      metadata: { dateSent: new Date(0), edited: false },
      attachments: [],
    });

    expect(normalizedInboundMessage(thread(), message).text).toBe(content);
  });

  it("keeps link targets in mention context lines and in the mention", async () => {
    const earlier = slackMessage(
      "1710000000.000004",
      "U1",
      "spec is at <https://docs.example.com/spec/v2/final|docs.example.com/spec/…>",
    );

    const current = slackMessage(
      "1710000000.000005",
      "U2",
      "<@U0AKERU> compare with <https://example.com/old-spec|the old one>",
    );

    const normalized = await mentionWithContext(thread([earlier, current]), current);

    expect(normalized.text).toBe(
      "U1: spec is at docs.example.com/spec/… (https://docs.example.com/spec/v2/final)\n@U0AKERU compare with the old one (https://example.com/old-spec)",
    );
  });

  it("keeps link targets in Discord history lines read with a mention", async () => {
    const earlier = discordHistoryMessage(
      "discord-history-1",
      "D1",
      "spec is at [docs.example.com/spec/…](https://docs.example.com/spec/v2/final)",
    );

    const current = discordHistoryMessage("discord-history-2", "D2", "<@APP> compare it");

    const normalized = await mentionWithContext(thread([earlier, current]), current);

    expect(normalized.text).toBe(
      "D1: spec is at docs.example.com/spec/… (https://docs.example.com/spec/v2/final)\n@APP compare it",
    );
  });
});
