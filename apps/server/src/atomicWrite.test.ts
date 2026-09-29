// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { writeFileStringAtomically } from "./atomicWrite.ts";

const NodeFS = NodeFSP;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => NodeFS.rm(directory, { recursive: true })),
  );
});

it.effect("syncs durable contents before publishing and the directory afterward", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-atomic-write-")),
    );
    directories.push(directory);
    const filePath = NodePath.join(directory, "memory.md");
    const operations: string[] = [];
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcessPlatform;
    const observedFs = {
      ...fs,
      open: (...args: Parameters<typeof fs.open>) =>
        fs.open(...args).pipe(
          Effect.map((file) => ({
            ...file,
            sync: Effect.sync(() => {
              operations.push(
                args[0] === directory ? "directory sync" : `file sync (${args[1]?.flag})`,
              );
            }).pipe(Effect.flatMap(() => file.sync)),
          })),
        ),
      rename: (...args: Parameters<typeof fs.rename>) =>
        Effect.sync(() => {
          operations.push("rename");
        }).pipe(Effect.flatMap(() => fs.rename(...args))),
    } satisfies FileSystem.FileSystem;
    yield* writeFileStringAtomically({
      filePath,
      contents: "saved",
      mode: 0o600,
      durable: true,
    }).pipe(Effect.provideService(FileSystem.FileSystem, observedFs));

    assert.deepEqual(
      operations,
      // Windows rejects a flush through a read-only handle, so the temporary file opens as r+.
      platform === "win32"
        ? ["file sync (r+)", "rename"]
        : ["file sync (r+)", "rename", "directory sync"],
    );
    assert.equal(yield* Effect.promise(() => NodeFS.readFile(filePath, "utf8")), "saved");
    if (platform !== "win32") {
      assert.equal((yield* Effect.promise(() => NodeFS.stat(filePath))).mode & 0o777, 0o600);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the previous file when syncing the replacement fails", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-atomic-write-")),
    );
    directories.push(directory);
    const filePath = NodePath.join(directory, "memory.md");
    yield* Effect.promise(() => NodeFS.writeFile(filePath, "previous"));
    const fs = yield* FileSystem.FileSystem;
    const failingFs = {
      ...fs,
      open: (...args: Parameters<typeof fs.open>) =>
        fs
          .open(...args)
          .pipe(Effect.map((file) => ({ ...file, sync: Effect.die(new Error("sync failed")) }))),
    } satisfies FileSystem.FileSystem;
    const result = yield* Effect.exit(
      writeFileStringAtomically({ filePath, contents: "replacement", durable: true }).pipe(
        Effect.provideService(FileSystem.FileSystem, failingFs),
      ),
    );
    assert.isTrue(Exit.isFailure(result));
    assert.equal(yield* Effect.promise(() => NodeFS.readFile(filePath, "utf8")), "previous");
  }).pipe(Effect.provide(NodeServices.layer)),
);
