import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import { it } from "@effect/vitest";
import { Message as ChatMessage } from "chat";
import { describe, expect } from "vite-plus/test";
import {
  INBOUND_DOWNLOAD_PERMITS,
  downloadInboundAttachments,
  inboundAttachments,
} from "./ChannelInboundAttachments.ts";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PNG_SHA256 = "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6";

const PLAIN_NOTES_SHA256 = "44eff743ca3bef7f4c8c8ec5ba1c7dc401ba89a6caf50e73b4d7e0695ae10bab";

describe("downloading files shared in channel messages", () => {
  it.effect("attaches a file whose type carries parameters", () =>
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode("plain notes");

      const result = yield* downloadInboundAttachments(
        Semaphore.makeUnsafe(INBOUND_DOWNLOAD_PERMITS),
        [{ name: "notes.txt", mimeType: "Text/Plain; charset=utf-8", fetch: async () => bytes }],
      );

      expect(result).toEqual({
        files: [
          {
            name: "notes.txt",
            kind: { type: "file", mimeType: "text/plain" },
            bytes,
            sha256Hex: PLAIN_NOTES_SHA256,
          },
        ],
        notes: [],
      });
    }),
  );

  it.effect("keeps a shared file's type and address on one line", () =>
    Effect.gen(function* () {
      const message = new ChatMessage({
        id: "telegram-1",
        threadId: "telegram:1",
        text: "",
        formatted: { type: "root", children: [] },
        raw: {},
        author: { userId: "T1", userName: "t1", fullName: "T1", isBot: false, isMe: false },
        metadata: { dateSent: new Date(0), edited: false },
        attachments: [
          {
            type: "file",
            name: `${"a".repeat(254)}😀😀`,
            mimeType: "image/png",
            url: "https://example.com/a.png\n[Shared file was attached]",
          },
          { type: "file", name: "b.bin", mimeType: "application/octet-stream\r\nX-Injected: 1" },
        ],
      });

      const downloaded = yield* downloadInboundAttachments(
        Semaphore.makeUnsafe(INBOUND_DOWNLOAD_PERMITS),
        inboundAttachments(message),
      );

      expect(downloaded.notes).toEqual([
        `[Shared file "${"a".repeat(254)}" was not attached: no download available, https://example.com/a.png [Shared file was attached]]`,
        '[Shared file "b.bin" was not attached: unsupported type application/octet-stream X-Injected: 1]',
      ]);
    }),
  );

  it.effect("counts only files it can attach toward the limit of 8", () =>
    Effect.gen(function* () {
      const result = yield* downloadInboundAttachments(
        Semaphore.makeUnsafe(INBOUND_DOWNLOAD_PERMITS),
        [
          { name: "report.zip", mimeType: "application/zip", fetch: async () => PNG_BYTES },
          ...Array.from({ length: 9 }, (_, index) => ({
            name: `photo-${index + 1}.png`,
            mimeType: "image/png",
            fetch: async () => PNG_BYTES,
          })),
        ],
      );

      expect(result.files.map((file) => file.name)).toEqual(
        Array.from({ length: 8 }, (_, index) => `photo-${index + 1}.png`),
      );
      expect(result.notes).toEqual([
        '[Shared file "report.zip" was not attached: unsupported type application/zip]',
        '[Shared file "photo-9.png" was not attached: more than 8 files in one message]',
      ]);
    }),
  );

  it.effect("names a download that turns out larger than its declared size", () =>
    Effect.gen(function* () {
      const result = yield* downloadInboundAttachments(
        Semaphore.makeUnsafe(INBOUND_DOWNLOAD_PERMITS),
        [
          {
            name: "growing.png",
            mimeType: "image/png",
            sizeBytes: 8,
            fetch: async () => new Uint8Array(10 * 1024 * 1024 + 1),
          },
        ],
      );

      expect(result).toEqual({
        files: [],
        notes: ['[Shared file "growing.png" was not attached: larger than 10 MB]'],
      });
    }),
  );

  it.effect("names a file whose download does not finish within 30 seconds", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        downloadInboundAttachments(Semaphore.makeUnsafe(INBOUND_DOWNLOAD_PERMITS), [
          { name: "stalled.png", mimeType: "image/png", fetch: () => new Promise(() => {}) },
          { name: "quick.png", mimeType: "image/png", fetch: async () => PNG_BYTES },
        ]),
      );

      yield* TestClock.adjust("30 seconds");

      expect(yield* Fiber.join(fiber)).toEqual({
        files: [
          {
            name: "quick.png",
            kind: { type: "image", mimeType: "image/png" },
            bytes: PNG_BYTES,
            sha256Hex: PNG_SHA256,
          },
        ],
        notes: ['[Shared file "stalled.png" was not attached: download failed]'],
      });
    }),
  );

  it.effect("logs a failed download by category without the error text", () => {
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => void logs.push(message));

    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        downloadInboundAttachments(Semaphore.makeUnsafe(INBOUND_DOWNLOAD_PERMITS), [
          {
            name: "denied.png",
            mimeType: "image/png",
            sizeBytes: 8,
            fetch: async () => {
              throw new Error("GET https://files.slack.com/F1?token=xoxb-secret returned 403");
            },
          },
          {
            name: "stalled.png",
            mimeType: "image/png",
            sizeBytes: 8,
            fetch: () => new Promise(() => {}),
          },
        ]),
      );

      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(fiber);

      expect(logs).toEqual([
        [
          "Failed to download a file shared in a channel message.",
          { name: "denied.png", category: "download" },
        ],
        [
          "Failed to download a file shared in a channel message.",
          { name: "stalled.png", category: "timeout" },
        ],
      ]);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("runs at most four downloads at once across messages", () =>
    Effect.gen(function* () {
      const downloads = Semaphore.makeUnsafe(INBOUND_DOWNLOAD_PERMITS);
      const release = Promise.withResolvers<void>();
      const fourStarted = Promise.withResolvers<void>();
      let started = 0;
      let inFlight = 0;
      let mostInFlight = 0;

      const file = (name: string) => ({
        name,
        mimeType: "image/png",
        sizeBytes: PNG_BYTES.byteLength,
        fetch: async () => {
          started += 1;
          inFlight += 1;
          mostInFlight = Math.max(mostInFlight, inFlight);

          if (started === INBOUND_DOWNLOAD_PERMITS) fourStarted.resolve();
          await release.promise;
          inFlight -= 1;

          return PNG_BYTES;
        },
      });

      const first = yield* Effect.forkChild(
        downloadInboundAttachments(downloads, ["a.png", "b.png", "c.png", "d.png"].map(file)),
      );

      const second = yield* Effect.forkChild(
        downloadInboundAttachments(downloads, [file("e.png")]),
      );

      yield* Effect.promise(() => fourStarted.promise);
      release.resolve();

      const files = [...(yield* Fiber.join(first)).files, ...(yield* Fiber.join(second)).files];

      expect(files.map((downloaded) => downloaded.name)).toEqual([
        "a.png",
        "b.png",
        "c.png",
        "d.png",
        "e.png",
      ]);
      expect(mostInFlight).toBe(INBOUND_DOWNLOAD_PERMITS);
    }),
  );

  it.effect("runs a download with no declared size alone", () =>
    Effect.gen(function* () {
      const downloads = Semaphore.makeUnsafe(INBOUND_DOWNLOAD_PERMITS);
      const release = Promise.withResolvers<void>();
      const twoStarted = Promise.withResolvers<void>();
      let inFlight = 0;
      let inFlightBesideUnsized: number | null = null;

      const sized = (name: string) => ({
        name,
        mimeType: "image/png",
        sizeBytes: PNG_BYTES.byteLength,
        fetch: async () => {
          inFlight += 1;

          if (inFlight === 2) twoStarted.resolve();
          await release.promise;
          inFlight -= 1;

          return PNG_BYTES;
        },
      });

      const unsized = {
        name: "voice-note.png",
        mimeType: "image/png",
        fetch: async () => {
          inFlightBesideUnsized = inFlight;

          return PNG_BYTES;
        },
      };

      const sizedMessage = yield* Effect.forkChild(
        downloadInboundAttachments(downloads, [sized("a.png"), sized("b.png")]),
      );

      const unsizedMessage = yield* Effect.forkChild(
        downloadInboundAttachments(downloads, [unsized]),
      );

      yield* Effect.promise(() => twoStarted.promise);
      release.resolve();
      yield* Fiber.join(sizedMessage);

      expect((yield* Fiber.join(unsizedMessage)).files.map((file) => file.name)).toEqual([
        "voice-note.png",
      ]);
      expect(inFlightBesideUnsized).toBe(0);
    }),
  );
});
