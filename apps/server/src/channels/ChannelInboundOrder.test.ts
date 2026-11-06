import {
  connectChannel,
  BOT_ID,
  makeHarness,
  slackConnect,
  externalAdapters,
} from "./testUtils/channelRuntime.ts";
import { type SlackEvent } from "@chat-adapter/slack";
import { type OrchestrationCommand } from "@akeru/contracts";
import { type Message } from "chat";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const connectSlack = Effect.gen(function* () {
  const harness = makeHarness({ startTransport: null });
  yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
  const { slackChat, slackAdapter } = externalAdapters;

  if (!slackChat || !slackAdapter) throw new Error("Expected the Slack Chat runtime.");

  const deliver = (message: Message) =>
    slackChat.processMessage(slackAdapter, message.threadId, message);

  const parse = (event: SlackEvent) => slackAdapter.parseMessage(event);

  const turns = () =>
    harness.commands.flatMap((command: OrchestrationCommand) =>
      command.type === "thread.turn.start"
        ? [
            [
              command.message.channelOrigin?.externalMessageId,
              command.message.attachments.map((attachment) => attachment.name),
            ],
          ]
        : [],
    );

  return { slackAdapter, parse, deliver, turns };
});

describe("channel messages that arrive while an earlier one is still in progress", () => {
  it.effect("keeps a question sent while the image before it downloads", () =>
    Effect.gen(function* () {
      const { parse, deliver, turns } = yield* connectSlack;
      const downloadStarted = Promise.withResolvers<void>();
      const releaseDownload = Promise.withResolvers<void>();

      const image = parse({
        type: "message",
        channel: "D123",
        ts: "1710000000.000101",
        thread_ts: "1710000000.000100",
        user: "U1",
        text: "",
        files: [
          {
            id: "F1",
            name: "shot.png",
            mimetype: "image/png",
            size: PNG_BYTES.byteLength,
            url_private: "https://files.slack.com/files-pri/T1-F1/shot.png",
          },
        ],
      });

      const [file] = image.attachments;

      if (!file) throw new Error("Expected the shared image.");

      file.fetchData = async () => {
        downloadStarted.resolve();
        await releaseDownload.promise;

        return Buffer.from(PNG_BYTES);
      };

      const first = deliver(image);
      yield* Effect.promise(() => downloadStarted.promise);

      const second = deliver(
        parse({
          type: "message",
          channel: "D123",
          ts: "1710000000.000102",
          thread_ts: "1710000000.000100",
          user: "U1",
          text: "what's this?",
        }),
      );

      releaseDownload.resolve();
      const settled = yield* Effect.promise(() => Promise.allSettled([first, second]));

      expect(settled).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(turns()).toEqual([
        ["1710000000.000101", ["shot.png"]],
        ["1710000000.000102", []],
      ]);
    }),
  );

  it.effect("starts a mention's turn before a reply that arrives while it reads the thread", () =>
    Effect.gen(function* () {
      const { slackAdapter, parse, deliver, turns } = yield* connectSlack;
      const fetchStarted = Promise.withResolvers<void>();
      const releaseFetch = Promise.withResolvers<void>();

      slackAdapter.fetchMessages = async () => {
        fetchStarted.resolve();
        await releaseFetch.promise;

        return { messages: [] };
      };

      const first = deliver(
        parse({
          type: "message",
          channel: "C123",
          ts: "1710000000.000201",
          thread_ts: "1710000000.000200",
          user: "U1",
          text: "<@U-AKERU> look at this thread",
        }),
      );

      yield* Effect.promise(() => fetchStarted.promise);

      const second = deliver(
        parse({
          type: "message",
          channel: "C123",
          ts: "1710000000.000202",
          thread_ts: "1710000000.000200",
          user: "U1",
          text: "and one more detail",
        }),
      );

      releaseFetch.resolve();
      const settled = yield* Effect.promise(() => Promise.allSettled([first, second]));

      expect(settled).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(turns()).toEqual([
        ["1710000000.000201", []],
        ["1710000000.000202", []],
      ]);
    }),
  );
});
