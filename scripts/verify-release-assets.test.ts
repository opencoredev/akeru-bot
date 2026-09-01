import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { expectedReleaseAssetNames, verifyReleaseAssets } from "./verify-release-assets.ts";

describe("verify-release-assets", () => {
  it("rejects missing assets and writes verified SHA256SUMS for the exact release set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "akeru-release-assets-"));
    const names = expectedReleaseAssetNames("1.2.3");
    for (const name of names) await writeFile(join(directory, name), name);

    const sums = await verifyReleaseAssets(directory, "1.2.3");
    assert.equal(sums, await readFile(join(directory, "SHA256SUMS"), "utf8"));
    assert.equal(sums.trimEnd().split("\n").length, names.length);

    await writeFile(join(directory, "unexpected.txt"), "unexpected");
    await assert.rejects(verifyReleaseAssets(directory, "1.2.3"), /Release assets differ/);
  });
});
