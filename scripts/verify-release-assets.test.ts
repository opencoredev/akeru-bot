// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated temporary release directories.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "vite-plus/test";

import { expectedReleaseAssetNames, verifyReleaseAssets } from "./verify-release-assets.ts";

describe("verify-release-assets", () => {
  it("rejects missing assets and writes verified SHA256SUMS for the exact release set", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "akeru-release-assets-"),
    );
    const names = expectedReleaseAssetNames("1.2.3");
    for (const name of names) await NodeFSP.writeFile(NodePath.join(directory, name), name);

    const sums = await verifyReleaseAssets(directory, "1.2.3");
    NodeAssert.equal(sums, await NodeFSP.readFile(NodePath.join(directory, "SHA256SUMS"), "utf8"));
    NodeAssert.equal(sums.trimEnd().split("\n").length, names.length);

    await NodeFSP.writeFile(NodePath.join(directory, "unexpected.txt"), "unexpected");
    await NodeAssert.rejects(verifyReleaseAssets(directory, "1.2.3"), /Release assets differ/);
  });
});
