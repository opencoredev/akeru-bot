import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@akeru/contracts";
import { it, expect } from "@effect/vitest";
import { readImageFile } from "./ImageFile.ts";

it.effect("loads multiple input images and rejects empty, missing, and oversized files", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-image-input-")),
    );

    try {
      const first = NodePath.join(directory, "first.png");
      const second = NodePath.join(directory, "second.png");
      const empty = NodePath.join(directory, "empty.png");
      const oversized = NodePath.join(directory, "oversized.png");
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.writeFile(first, new Uint8Array([1, 2, 3])),
          NodeFSP.writeFile(second, new Uint8Array([4, 5])),
          NodeFSP.writeFile(empty, ""),
          NodeFSP.writeFile(oversized, ""),
        ]),
      );
      yield* Effect.promise(() =>
        NodeFSP.truncate(oversized, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1),
      );
      expect(yield* Effect.all([readImageFile(first), readImageFile(second)])).toEqual([
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5]),
      ]);

      for (const path of [empty, oversized, NodePath.join(directory, "missing.png")])
        expect(yield* readImageFile(path)).toBeNull();
    } finally {
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns null when closing an input image fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-image-close-" });
    const path = NodePath.join(directory, "image.png");
    yield* fs.writeFile(path, new Uint8Array([1, 2, 3]));

    const closeError = PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "open",
      cause: new Error("close failed"),
    });

    const result = yield* readImageFile(path).pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        open: (filePath, options) =>
          Effect.gen(function* () {
            const handle = yield* fs.open(filePath, options);
            yield* Effect.addFinalizer(() => Effect.die(closeError));

            return handle;
          }),
      }),
    );

    expect(result).toBeNull();
  }).pipe(Effect.provide(NodeServices.layer)),
);
