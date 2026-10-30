import { createSlackAdapter, type SlackEvent } from "@chat-adapter/slack";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { describe, expect } from "vite-plus/test";
import { CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT, mentionWithContext } from "./ChannelInbound.ts";
import {
  INBOUND_DOWNLOAD_PERMITS,
  downloadInboundAttachments,
} from "./ChannelInboundAttachments.ts";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const slack = createSlackAdapter({
  mode: "socket",
  botToken: "xoxb-test",
  appToken: "xapp-test",
});

const slackMessage = (ts: string, user: string, text: string, ...fileNames: string[]) => {
  const message = slack.parseMessage({
    type: "message",
    channel: "C1",
    ts,
    thread_ts: "1710000000.000001",
    user,
    text,
    files: fileNames.map((name) => ({
      id: name,
      name,
      mimetype: name.endsWith(".png") ? "image/png" : "application/zip",
      size: 8,
      url_private: `https://files.slack.com/files-pri/T1-F1/${name}`,
    })),
  } satisfies SlackEvent);

  for (const attachment of message.attachments) {
    attachment.fetchData = async () => {
      if (attachment.name?.startsWith("broken")) throw new Error("Slack returned 403");

      return Buffer.from(PNG_BYTES);
    };
  }

  return message;
};

type SlackMessage = ReturnType<typeof slackMessage>;

const mentionOf = (
  recentMessages: ReadonlyArray<SlackMessage>,
  mention = recentMessages.find((message) => message.text.startsWith("@U0AKERU")),
) =>
  Effect.gen(function* () {
    if (!mention) throw new Error("Expected a mention.");

    const inbound = yield* Effect.promise(() =>
      mentionWithContext(
        {
          id: "slack:C1:1710000000.000001",
          recentMessages: [...recentMessages],
          refresh: async () => undefined,
        },
        mention,
      ),
    );

    const downloaded = yield* downloadInboundAttachments(
      Semaphore.makeUnsafe(INBOUND_DOWNLOAD_PERMITS),
      inbound.attachments,
    );

    return {
      text: inbound.text,
      lines: inbound.text.split("\n"),
      contextLength: inbound.text.length - mention.text.length - 1,
      files: inbound.attachments.map((attachment) => attachment.name),
      downloaded: downloaded.files.map((file) => file.name),
      notes: downloaded.notes,
    };
  });

const OLDER_LINE = "U1: [shared old.png]";

const newerLineOf = (length: number) => `U2: ${"x".repeat(length - 4)}`;

describe("mention context", () => {
  it.effect("drops an older file whose marker no longer fits beside a newer long line", () =>
    Effect.gen(function* () {
      const newerLine = newerLineOf(CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT - 10);

      const context = yield* mentionOf([
        slackMessage("1710000000.000002", "U1", "", "old.png"),
        slackMessage("1710000000.000003", "U2", newerLine.slice(4)),
        slackMessage("1710000000.000004", "U3", "<@U0AKERU> what changed?", "mine.png"),
      ]);

      expect(context.lines).toEqual([" old.png]", newerLine, "@U0AKERU what changed?"]);
      expect(context.contextLength).toBe(CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT);
      expect(context.files).toEqual(["mine.png"]);
    }),
  );

  it.effect("keeps an older file whose line fits exactly within the limit", () =>
    Effect.gen(function* () {
      const newerLine = newerLineOf(
        CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT - OLDER_LINE.length - 1,
      );

      const context = yield* mentionOf([
        slackMessage("1710000000.000002", "U1", "", "old.png"),
        slackMessage("1710000000.000003", "U2", newerLine.slice(4)),
        slackMessage("1710000000.000004", "U3", "<@U0AKERU> what changed?", "mine.png"),
      ]);

      expect(context.lines).toEqual([OLDER_LINE, newerLine, "@U0AKERU what changed?"]);
      expect(context.contextLength).toBe(CHANNEL_MENTION_CONTEXT_CHARACTER_LIMIT);
      expect(context.files).toEqual(["mine.png", "old.png"]);
    }),
  );

  it.effect("leaves out messages sent after the mention", () =>
    Effect.gen(function* () {
      const context = yield* mentionOf([
        slackMessage("1710000000.000002", "U1", "before", "before.png"),
        slackMessage("1710000000.000003", "U3", "<@U0AKERU> what changed?"),
        slackMessage("1710000000.000004", "U2", "after", "after.png"),
      ]);

      expect(context.lines).toEqual(["U1: before [shared before.png]", "@U0AKERU what changed?"]);
      expect(context.files).toEqual(["before.png"]);
    }),
  );

  it.effect("leaves out later messages when the thread history no longer holds the mention", () =>
    Effect.gen(function* () {
      const context = yield* mentionOf(
        [
          slackMessage("1710000000.000002", "U1", "before"),
          slackMessage("1710000000.200000", "U2", "after", "after.png"),
        ],
        slackMessage("1710000000.100000", "U3", "<@U0AKERU> what changed?"),
      );

      expect(context.text).toBe("U1: before\n@U0AKERU what changed?");
      expect(context.files).toEqual([]);
    }),
  );

  it.effect("leaves out a later reply from the mention's millisecond when history lacks it", () =>
    Effect.gen(function* () {
      const context = yield* mentionOf(
        [
          slackMessage("1710000000.000002", "U1", "before"),
          slackMessage("1710000000.100400", "U2", "after", "after.png"),
        ],
        slackMessage("1710000000.100000", "U3", "<@U0AKERU> what changed?"),
      );

      expect(context.text).toBe("U1: before\n@U0AKERU what changed?");
      expect(context.files).toEqual([]);
    }),
  );

  it.effect("names only the mention's own files that were not attached", () =>
    Effect.gen(function* () {
      const own = Array.from({ length: 9 }, (_, index) => `own-${index + 1}.png`);

      const context = yield* mentionOf([
        slackMessage("1710000000.000002", "U1", "", "ctx.zip", "ctx.png"),
        slackMessage("1710000000.000003", "U3", "<@U0AKERU> what changed?", ...own),
      ]);

      expect(context.lines[0]).toBe("U1: [shared ctx.zip] [shared ctx.png]");
      expect(context.downloaded).toEqual(own.slice(0, 8));
      expect(context.notes).toEqual([
        '[Shared file "own-9.png" was not attached: more than 8 files in one message]',
      ]);
    }),
  );

  it.effect("names a mention's own file it could not attach but not a context file", () =>
    Effect.gen(function* () {
      const context = yield* mentionOf([
        slackMessage("1710000000.000002", "U1", "", "broken.png", "ctx.zip"),
        slackMessage("1710000000.000003", "U3", "<@U0AKERU> what changed?", "own.zip", "own.png"),
      ]);

      expect(context.downloaded).toEqual(["own.png"]);
      expect(context.notes).toEqual([
        '[Shared file "own.zip" was not attached: unsupported type application/zip]',
      ]);
    }),
  );
});
