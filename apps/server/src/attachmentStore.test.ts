import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { describe, expect } from "vite-plus/test";

import {
  createAttachmentId,
  createPendingAttachmentId,
  parseAttachmentUuid,
  planAttachmentClaim,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
  writeAttachment,
  writeFileAtomically,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();

    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();

    if (!attachmentId) {
      return;
    }

    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("reserves the pending attachment segment", () => {
    const pendingId = createPendingAttachmentId();
    expect(parseThreadSegmentFromAttachmentId(pendingId)).toBe("pending");
    expect(parseAttachmentUuid(pendingId)).toMatch(/^[a-f0-9-]{36}$/);
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending")!)).toBe("_pending");
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending_thread")!)).toBe(
      "pending_thread",
    );
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );

    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });

      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );

    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });

      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("plans pending attachment claims with direct filename lookups", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-claim-"),
    );

    try {
      const uuid = "00000000-0000-4000-8000-000000000001";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

      const claim = planAttachmentClaim({
        attachmentsDir,
        threadId: "thread-1",
        attachmentId: `pending-${uuid}`,
      });

      expect(claim).toMatchObject({
        ok: true,
        currentPath: pendingPath,
      });

      if (!claim.ok) {
        return;
      }

      expect(parseThreadSegmentFromAttachmentId(claim.finalId)).toBe("thread-1");
      expect(parseAttachmentUuid(claim.finalId)).not.toBe(uuid);
      expect(claim.finalPath).toBe(NodePath.join(attachmentsDir, `${claim.finalId}.png`));
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects thread-owned attachments even when thread segments collide", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-ownership-"),
    );

    try {
      const attachmentId = "a-b-00000000-0000-4000-8000-000000000003";
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachmentId}.png`), "pixels");

      expect(planAttachmentClaim({ attachmentsDir, threadId: "a b", attachmentId })).toEqual({
        ok: false,
        reason: "attachment must be a pending upload",
      });
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("removes expired pending and partial files without touching thread attachments", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-sweep-"),
    );

    try {
      const now = 1_800_000_000_000;
      const oldTimeSeconds = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      const uuid = "00000000-0000-4000-8000-000000000002";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      const threadPath = NodePath.join(attachmentsDir, `thread-1-${uuid}.png`);
      const partialPath = NodePath.join(attachmentsDir, `${uuid}.part`);

      for (const filePath of [pendingPath, threadPath, partialPath]) {
        NodeFS.writeFileSync(filePath, Buffer.from("pixels"));
        NodeFS.utimesSync(filePath, oldTimeSeconds, oldTimeSeconds);
      }

      expect(sweepStalePendingAttachments({ attachmentsDir, nowMs: now })).toEqual({ deleted: 2 });
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(partialPath)).toBe(false);
      expect(NodeFS.existsSync(threadPath)).toBe(true);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it.effect("replaces a rewritten attachment whole and leaves no partial file behind", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-attachment-write-",
      });

      const write = (bytes: Uint8Array) =>
        writeAttachment({
          attachmentsDir,
          attachment: {
            type: "file",
            id: "thread-1-00000000-0000-4000-8000-000000000003",
            name: "notes.txt",
            mimeType: "text/plain",
          },
          bytes,
        });

      yield* write(Buffer.from("first version"));
      const saved = yield* write(Buffer.from("second"));
      const fileName = "thread-1-00000000-0000-4000-8000-000000000003.txt";

      expect(saved.sizeBytes).toBe(6);
      expect(NodeFS.readdirSync(attachmentsDir)).toEqual([fileName]);
      expect(NodeFS.readFileSync(NodePath.join(attachmentsDir, fileName), "utf8")).toBe("second");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the previous attachment when a rewrite fails part way", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fileName = "thread-1-00000000-0000-4000-8000-000000000004.txt";

      const failure = (method: string) =>
        PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method });

      const failingFileSystems: ReadonlyArray<FileSystem.FileSystem> = [
        {
          ...fileSystem,
          writeFile: (path, data) =>
            fileSystem
              .writeFile(path, data.subarray(0, 3))
              .pipe(Effect.andThen(Effect.fail(failure("writeFile")))),
        },
        { ...fileSystem, rename: () => Effect.fail(failure("rename")) },
      ];

      for (const failingFileSystem of failingFileSystems) {
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3code-attachment-failed-rewrite-",
        });

        const write = (bytes: Uint8Array) =>
          writeAttachment({
            attachmentsDir,
            attachment: {
              type: "file",
              id: "thread-1-00000000-0000-4000-8000-000000000004",
              name: "notes.txt",
              mimeType: "text/plain",
            },
            bytes,
          });

        yield* write(Buffer.from("first version"));

        const failed = yield* write(Buffer.from("second version")).pipe(
          Effect.provideService(FileSystem.FileSystem, failingFileSystem),
          Effect.flip,
        );

        expect(failed._tag).toBe("AttachmentWriteError");
        expect(NodeFS.readdirSync(attachmentsDir)).toEqual([fileName]);
        expect(NodeFS.readFileSync(NodePath.join(attachmentsDir, fileName), "utf8")).toBe(
          "first version",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the partial file when a write is interrupted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const written = yield* Deferred.make<void>();

      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-attachment-interrupt-",
      });

      const stalledFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        writeFile: (path, data, options) =>
          fileSystem
            .writeFile(path, data, options)
            .pipe(
              Effect.andThen(Deferred.succeed(written, undefined)),
              Effect.andThen(Effect.never),
            ),
      };

      const write = yield* writeFileAtomically(
        NodePath.join(attachmentsDir, "notes.txt"),
        Buffer.from("partial"),
      ).pipe(Effect.provideService(FileSystem.FileSystem, stalledFileSystem), Effect.forkChild);

      yield* Deferred.await(written);
      yield* Fiber.interrupt(write);

      expect(NodeFS.readdirSync(attachmentsDir)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
