import {
  connectChannel,
  dispatchInboundChannelMessage,
  BOT_ID,
  PROJECT_ID,
  makeBot,
  makeHarness,
  slackConnect,
  telegramConnect,
  externalAdapters,
} from "./testUtils/channelRuntime.ts";
import * as NodeFS from "node:fs";
import { type SlackEvent } from "@chat-adapter/slack";
import { BotId, type OrchestrationCommand } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Fiber from "effect/Fiber";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { AttachmentWriteError, resolveAttachmentPathById } from "../attachmentStore.ts";
import { type InboundDispatchInput, mentionWithContext } from "./ChannelInbound.ts";
import {
  INBOUND_DOWNLOAD_PERMITS,
  downloadInboundAttachments,
} from "./ChannelInboundAttachments.ts";
import {
  type ChannelRuntimeDependencies,
  type InboundCallback,
  type InboundChannelAttachment,
} from "./ChannelRuntimeTypes.ts";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type SlackFile = NonNullable<SlackEvent["files"]>[number];

const pngFile: SlackFile = {
  id: "F1",
  name: "shot.png",
  mimetype: "image/png",
  size: PNG_BYTES.byteLength,
  url_private: "https://files.slack.com/files-pri/T1-F1/shot.png",
};

const zipFile: SlackFile = {
  id: "F2",
  name: "report.zip",
  mimetype: "application/zip",
  size: 2_048,
  url_private: "https://files.slack.com/files-pri/T1-F2/report.zip",
};

const connectSlack = Effect.gen(function* () {
  const harness = makeHarness({ startTransport: null });
  yield* connectChannel(harness.dependencies, slackConnect(BOT_ID));
  const { slackChat, slackAdapter } = externalAdapters;

  if (!slackChat || !slackAdapter) throw new Error("Expected the Slack Chat runtime.");

  const downloads: string[] = [];

  const parse = (event: SlackEvent) => {
    const message = slackAdapter.parseMessage(event);

    for (const attachment of message.attachments) {
      attachment.fetchData = async () => {
        downloads.push(attachment.name ?? "");

        return Buffer.from(PNG_BYTES);
      };
    }

    return message;
  };

  const deliver = (event: SlackEvent) => {
    const message = parse(event);

    return Effect.promise(() => slackChat.processMessage(slackAdapter, message.threadId, message));
  };

  const turns = () =>
    harness.commands.filter(
      (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        command.type === "thread.turn.start",
    );

  return { harness, parse, deliver, downloads, turns };
});

const dispatchShared = (
  dependencies: ChannelRuntimeDependencies,
  input: Omit<InboundDispatchInput, "attachments"> & {
    readonly attachments: ReadonlyArray<InboundChannelAttachment>;
  },
) =>
  downloadInboundAttachments(
    Semaphore.makeUnsafe(INBOUND_DOWNLOAD_PERMITS),
    input.attachments,
  ).pipe(
    Effect.flatMap((attachments) =>
      dispatchInboundChannelMessage(dependencies, { ...input, attachments }),
    ),
  );

const turnStarts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
      command.type === "thread.turn.start",
  );

const storedBytes = (attachmentsDir: string, attachmentId: string) => {
  const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });

  return path ? Uint8Array.from(NodeFS.readFileSync(path)) : null;
};

describe("files shared in channel messages", () => {
  it.effect("passes an image shared with a Slack mention to the bot", () =>
    Effect.gen(function* () {
      const { harness, deliver, turns } = yield* connectSlack;

      yield* deliver({
        type: "message",
        channel: "C123",
        ts: "1710000000.000001",
        user: "U1",
        text: "<@U-AKERU> what is in this screenshot?",
        files: [pngFile],
      });

      const [turn] = turns();
      const attachment = turn?.message.attachments[0];

      expect(turn?.message.text).toBe("<@U-AKERU> what is in this screenshot?");
      expect(turn?.message.attachments).toEqual([
        {
          type: "image",
          id: expect.stringMatching(new RegExp(`^${turn?.threadId}-[0-9a-f-]{36}$`)),
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 8,
        },
      ]);
      expect(storedBytes(harness.attachmentsDir, attachment?.id ?? "")).toEqual(PNG_BYTES);
    }),
  );

  it.effect("starts a turn for an image sent with no text", () =>
    Effect.gen(function* () {
      const { harness, deliver, turns } = yield* connectSlack;

      yield* deliver({
        type: "message",
        channel: "D123",
        ts: "1710000000.000002",
        user: "U1",
        text: "",
        files: [pngFile],
      });

      const [turn] = turns();

      expect(turns()).toHaveLength(1);
      expect(turn?.message.text).toBe("");
      expect(turn?.message.attachments.map(({ id: _id, ...rest }) => rest)).toEqual([
        { type: "image", name: "shot.png", mimeType: "image/png", sizeBytes: 8 },
      ]);
      expect(storedBytes(harness.attachmentsDir, turn?.message.attachments[0]?.id ?? "")).toEqual(
        PNG_BYTES,
      );
    }),
  );

  it.effect("names an unsupported file to the bot without downloading it", () =>
    Effect.gen(function* () {
      const { deliver, downloads, turns } = yield* connectSlack;

      yield* deliver({
        type: "message",
        channel: "D123",
        ts: "1710000000.000003",
        user: "U1",
        text: "here are both",
        files: [zipFile, pngFile],
      });

      const [turn] = turns();

      expect(turn?.message.text).toBe(
        'here are both\n[Shared file "report.zip" was not attached: unsupported type application/zip]',
      );
      expect(turn?.message.attachments.map((attachment) => attachment.name)).toEqual(["shot.png"]);
      expect(downloads).toEqual(["shot.png"]);
    }),
  );

  it.effect("keeps the stored file when a message is delivered again", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});

      const inbound = {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "slack" as const,
        externalThreadId: "slack:D123:1710000000.000004",
        externalMessageId: "1710000000.000004",
        text: "again",
        attachments: [
          {
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 8,
            fetch: async () => PNG_BYTES,
          },
        ],
      };

      yield* dispatchShared(harness.dependencies, inbound);
      const [stored] = NodeFS.readdirSync(harness.attachmentsDir);
      const storedPath = `${harness.attachmentsDir}/${stored}`;
      const { ino } = NodeFS.statSync(storedPath);
      const openReader = NodeFS.openSync(storedPath, "r");

      yield* dispatchShared(harness.dependencies, inbound).pipe(
        Effect.ensuring(Effect.sync(() => NodeFS.closeSync(openReader))),
      );

      const turns = harness.commands.filter((command) => command.type === "thread.turn.start");
      const [first, second] = turns.map((turn) => turn.message.attachments);

      expect(turns).toHaveLength(2);
      expect(first).toHaveLength(1);
      expect(second).toEqual(first);
      expect(NodeFS.readdirSync(harness.attachmentsDir)).toEqual([`${first?.[0]?.id}.png`]);
      expect(NodeFS.statSync(storedPath).ino).toBe(ino);
    }),
  );

  it.effect("names files it could not attach and still starts the turn", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});

      yield* dispatchShared(harness.dependencies, {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "discord",
        externalThreadId: "discord:G1:C1:T1",
        externalMessageId: "discord-files-1",
        text: "",
        attachments: [
          {
            name: "broken.png",
            mimeType: "image/png",
            fetch: async () => {
              throw new Error("connection reset");
            },
          },
          { name: "linked.png", mimeType: "image/png", url: "https://cdn.example.com/linked.png" },
          { name: "huge.pdf", mimeType: "application/pdf", sizeBytes: 11 * 1024 * 1024 },
          { name: "notes.md", mimeType: "text/markdown", fetch: async () => new Uint8Array() },
          ...Array.from({ length: 5 }, (_, index) => ({
            name: `photo-${index + 5}.png`,
            mimeType: "image/png",
            fetch: async () => PNG_BYTES,
          })),
        ],
      });

      const [turn] = turnStarts(harness.commands);

      expect(turn?.message.text).toBe(
        [
          '[Shared file "broken.png" was not attached: download failed]',
          '[Shared file "linked.png" was not attached: no download available, https://cdn.example.com/linked.png]',
          '[Shared file "huge.pdf" was not attached: larger than 10 MB]',
          '[Shared file "notes.md" was not attached: the file is empty]',
        ].join("\n"),
      );
      expect(turn?.message.attachments.map((attachment) => attachment.name)).toEqual([
        "photo-5.png",
        "photo-6.png",
        "photo-7.png",
        "photo-8.png",
        "photo-9.png",
      ]);
    }),
  );

  it.effect("keeps a shared file's name on one line", () =>
    Effect.gen(function* () {
      const { deliver, turns } = yield* connectSlack;

      yield* deliver({
        type: "message",
        channel: "D123",
        ts: "1710000000.000010",
        user: "U1",
        text: "look",
        files: [{ ...zipFile, name: ' quarterly\r\n\t"final"   report.zip ' }],
      });

      expect(turns()[0]?.message.text).toBe(
        'look\n[Shared file "quarterly "final" report.zip" was not attached: unsupported type application/zip]',
      );
    }),
  );

  it.effect("caps a shared file's name at 255 UTF-16 units without splitting an emoji", () =>
    Effect.gen(function* () {
      const { deliver, turns } = yield* connectSlack;

      yield* deliver({
        type: "message",
        channel: "D123",
        ts: "1710000000.000011",
        user: "U1",
        text: "look",
        files: [{ ...pngFile, name: `${"🙂".repeat(200)}.png` }],
      });

      expect(turns()[0]?.message.attachments.map((attachment) => attachment.name)).toEqual([
        "🙂".repeat(127),
      ]);
    }),
  );

  it.effect("stores each shared file under its own id", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});

      yield* dispatchShared(harness.dependencies, {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "telegram",
        externalThreadId: "telegram:files",
        externalMessageId: "telegram-files-1",
        text: "three files",
        attachments: [
          ["one.txt", "one"],
          ["two.txt", "two"],
          ["copy.txt", "one"],
        ].map(([name, content]) => ({
          name: name ?? "",
          mimeType: "text/plain",
          fetch: async () => new TextEncoder().encode(content),
        })),
      });

      const attachments = turnStarts(harness.commands)[0]?.message.attachments ?? [];

      expect(attachments.map((attachment) => attachment.name)).toEqual([
        "one.txt",
        "two.txt",
        "copy.txt",
      ]);
      expect(new Set(attachments.map((attachment) => attachment.id)).size).toBe(3);
      expect(NodeFS.readdirSync(harness.attachmentsDir)).toHaveLength(3);
      expect(
        attachments.map((attachment) =>
          new TextDecoder().decode(
            storedBytes(harness.attachmentsDir, attachment.id) ?? new Uint8Array(),
          ),
        ),
      ).toEqual(["one", "two", "one"]);
    }),
  );

  it.effect("keeps a context file's id when a file before it is gone on redelivery", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});

      const file = (name: string) => ({
        name,
        mimeType: "text/plain",
        fetch: async () => new TextEncoder().encode(name),
      });

      const mention = {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "slack" as const,
        externalThreadId: "slack:C123:1710000000.000050",
        externalMessageId: "1710000000.000052",
        text: "@U0AKERU compare these",
      };

      yield* dispatchShared(harness.dependencies, {
        ...mention,
        attachments: [file("mine.txt"), file("deleted.txt"), file("kept.txt")],
      });
      yield* dispatchShared(harness.dependencies, {
        ...mention,
        attachments: [file("mine.txt"), file("kept.txt")],
      });

      const [first, second] = turnStarts(harness.commands).map((turn) =>
        Object.fromEntries(turn.message.attachments.map(({ name, id }) => [name, id])),
      );

      expect(second).toEqual({ "mine.txt": first?.["mine.txt"], "kept.txt": first?.["kept.txt"] });
      expect(NodeFS.readdirSync(harness.attachmentsDir)).toHaveLength(3);
    }),
  );

  it.effect("names a file it could not save and still starts the turn", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});

      const dependencies: ChannelRuntimeDependencies = {
        ...harness.dependencies,
        writeAttachmentIfMissing: (attachment) =>
          Effect.fail(new AttachmentWriteError({ attachmentId: attachment.id })),
      };

      yield* dispatchShared(dependencies, {
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "slack",
        externalThreadId: "slack:D123:1710000000.000009",
        externalMessageId: "1710000000.000009",
        text: "can you see this?",
        attachments: [{ name: "shot.png", mimeType: "image/png", fetch: async () => PNG_BYTES }],
      });

      const [turn] = turnStarts(harness.commands);

      expect(turn?.message.text).toBe(
        'can you see this?\n[Shared file "shot.png" was not attached: it could not be saved]',
      );
      expect(turn?.message.attachments).toEqual([]);
    }),
  );

  it.effect("lets another bot on the same provider reply while a file downloads", () =>
    Effect.gen(function* () {
      const otherBotId = BotId.make("bot-other");
      const callbacks = new Map<string, InboundCallback>();

      const harness = makeHarness({
        bots: [makeBot(BOT_ID), makeBot(otherBotId)],
        startTransport: async (input, onInbound) => {
          callbacks.set(input.botId, onInbound);

          return {
            externalIdentity: "@akeru",
            runtime: { post: async () => undefined, shutdown: async () => undefined },
          };
        },
      });

      yield* connectChannel(harness.dependencies, telegramConnect(BOT_ID));
      yield* connectChannel(
        harness.dependencies,
        telegramConnect(otherBotId, "other-telegram-token"),
      );

      const downloadStarted = Promise.withResolvers<void>();
      const releaseDownload = Promise.withResolvers<void>();

      const slowFile = yield* Effect.forkChild(
        Effect.promise(async () =>
          callbacks.get(BOT_ID)?.({
            externalThreadId: "telegram:slow",
            externalMessageId: "slow-1",
            text: "big photo",
            attachments: [
              {
                name: "photo.png",
                mimeType: "image/png",
                fetch: async () => {
                  downloadStarted.resolve();
                  await releaseDownload.promise;

                  return PNG_BYTES;
                },
              },
            ],
          }),
        ),
      );

      yield* Effect.promise(() => downloadStarted.promise);
      yield* Effect.promise(async () =>
        callbacks.get(otherBotId)?.({
          externalThreadId: "telegram:quick",
          externalMessageId: "quick-1",
          text: "hello",
          attachments: [],
        }),
      );

      expect(turnStarts(harness.commands).map((turn) => turn.message.text)).toEqual(["hello"]);

      releaseDownload.resolve();
      yield* Fiber.join(slowFile);

      expect(
        turnStarts(harness.commands).map((turn) => [
          turn.message.text,
          turn.message.attachments.map((attachment) => attachment.name),
        ]),
      ).toEqual([
        ["hello", []],
        ["big photo", ["photo.png"]],
      ]);
    }),
  );

  it.effect("passes a screenshot shared before a Slack mention to the bot", () =>
    Effect.gen(function* () {
      const { harness, parse, turns } = yield* connectSlack;

      const thread = (event: Partial<SlackEvent>) =>
        parse({
          type: "message",
          channel: "C123",
          thread_ts: "1710000000.000030",
          user: "U1",
          text: "",
          ...event,
        });

      const screenshot = thread({ ts: "1710000000.000030", files: [pngFile] });

      const mention = thread({
        ts: "1710000000.000031",
        user: "U2",
        text: "<@U0AKERU> what's wrong here?",
      });

      const inbound = yield* Effect.promise(() =>
        mentionWithContext(
          {
            id: mention.threadId,
            recentMessages: [screenshot, mention],
            refresh: async () => undefined,
          },
          mention,
        ),
      );

      yield* dispatchShared(harness.dependencies, {
        ...inbound,
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "slack",
      });

      const [turn] = turns();

      expect(turn?.message.text).toBe("U1: [shared shot.png]\n@U0AKERU what's wrong here?");
      expect(turn?.message.attachments.map(({ id: _id, ...rest }) => rest)).toEqual([
        { type: "image", name: "shot.png", mimeType: "image/png", sizeBytes: 8 },
      ]);
      expect(storedBytes(harness.attachmentsDir, turn?.message.attachments[0]?.id ?? "")).toEqual(
        PNG_BYTES,
      );
    }),
  );

  it.effect("orders a mention's own files before context files, newest context first", () =>
    Effect.gen(function* () {
      const { harness, parse, turns } = yield* connectSlack;
      let ts = 40;

      const thread = (text: string, name?: string) => {
        ts += 1;

        return parse({
          type: "message",
          channel: "C123",
          ts: `1710000000.0000${ts}`,
          thread_ts: "1710000000.000040",
          user: "U1",
          text,
          ...(name ? { files: [{ ...pngFile, id: name, name }] } : {}),
        });
      };

      const outsideWindow = thread("", "old.png");
      const chatter = Array.from({ length: 8 }, (_, index) => thread(`note ${index}`));
      const described = thread("first try", "a.png");
      const fileOnly = thread("", "b.png");
      const mention = thread("<@U0AKERU> compare these", "c.png");

      const inbound = yield* Effect.promise(() =>
        mentionWithContext(
          {
            id: mention.threadId,
            recentMessages: [outsideWindow, ...chatter, described, fileOnly, mention],
            refresh: async () => undefined,
          },
          mention,
        ),
      );

      yield* dispatchShared(harness.dependencies, {
        ...inbound,
        botId: BOT_ID,
        projectId: PROJECT_ID,
        provider: "slack",
      });

      const [turn] = turns();

      expect(turn?.message.text.split("\n").slice(-3)).toEqual([
        "U1: first try [shared a.png]",
        "U1: [shared b.png]",
        "@U0AKERU compare these",
      ]);
      expect(turn?.message.attachments.map((attachment) => attachment.name)).toEqual([
        "c.png",
        "b.png",
        "a.png",
      ]);
    }),
  );
});
