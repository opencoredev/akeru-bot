import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { describe, expect, it } from "@effect/vitest";
import { makeAkeruRuntimeSeam } from "../AkeruRuntimeSeam.ts";
import { workspaceIO } from "../test-support/workspaceIO.ts";
import { makeBotWorkspaceIO } from "./BotWorkspaceIO.ts";
import { readIdentity, writeIdentity } from "./BotWorkspaceLifecycle.ts";

describe("BotWorkspaceIO", () => {
  it.effect("translates only FileSystem NotFound into an absent identity", () =>
    Effect.gen(function* () {
      const { runPromise } = yield* makeAkeruRuntimeSeam;
      const path = workspaceIO.path;

      for (const reason of ["NotFound", "PermissionDenied"] as const) {
        const error = PlatformError.systemError({
          _tag: reason,
          module: "FileSystem",
          method: "readFileString",
          pathOrDescriptor: "identity.json",
        });

        const fs = FileSystem.makeNoop({ readFileString: () => Effect.fail(error) });
        const io = makeBotWorkspaceIO(fs, path, runPromise);

        if (reason === "NotFound") {
          yield* Effect.promise(() =>
            expect(readIdentity(io, "identity.json")).resolves.toBeUndefined(),
          );
        } else {
          yield* Effect.promise(() =>
            expect(readIdentity(io, "identity.json")).rejects.toBe(error),
          );
        }
      }
    }),
  );

  it("writes an atomic private identity and removes missing paths safely", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "akeru-workspace-io-"));
    const file = NodePath.join(root, "private", "provider.json");

    try {
      await expect(readIdentity(workspaceIO, file)).resolves.toBeUndefined();
      await writeIdentity(workspaceIO, file, { provider: "ascii", providerId: "box-1" });
      await expect(readIdentity(workspaceIO, file)).resolves.toEqual({
        provider: "ascii",
        providerId: "box-1",
      });
      expect((await NodeFSP.stat(NodePath.dirname(file))).mode & 0o777).toBe(0o700);
      expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
      expect(await NodeFSP.readdir(NodePath.dirname(file))).toEqual(["provider.json"]);
      await workspaceIO.remove(file);
      await workspaceIO.remove(file);
      await workspaceIO.remove(NodePath.dirname(file), true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed persisted identities", async () => {
    await expect(
      readIdentity(
        { ...workspaceIO, readIdentity: async () => '{"provider":"ascii","providerId":""}' },
        "identity.json",
      ),
    ).rejects.toThrow("is invalid");
  });
});
