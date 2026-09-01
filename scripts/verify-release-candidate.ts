// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Release verification runs before an Effect runtime exists.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { expectedReleaseAssetNames } from "./verify-release-assets.ts";

const sha256 = (path: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");

export function verifyReleaseCandidate(directory: string, version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Stable release version must be plain semver, received '${version}'.`);
  }

  const stableAssets = expectedReleaseAssetNames(version);
  const expected = [...stableAssets, "SHA256SUMS"].sort();
  const actual = NodeFS.readdirSync(directory).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Release assets do not match.\nExpected: ${expected.join(", ")}\nActual: ${actual.join(", ")}`,
    );
  }

  const checksums = new Map(
    NodeFS.readFileSync(NodePath.join(directory, "SHA256SUMS"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        const match = /^([a-f0-9]{64})  ([^/]+)$/.exec(line);
        if (!match) throw new Error(`Invalid SHA256SUMS line: '${line}'.`);
        return [match[2], match[1]];
      }),
  );

  for (const asset of stableAssets) {
    const digest = sha256(NodePath.join(directory, asset));
    if (checksums.get(asset) !== digest) {
      throw new Error(`SHA256 mismatch for '${asset}'.`);
    }
  }
  if (checksums.size !== stableAssets.length) {
    throw new Error("SHA256SUMS does not contain exactly one entry for every release asset.");
  }
}

export function writeReleaseChecksums(directory: string, version: string): void {
  const contents = expectedReleaseAssetNames(version)
    .map((asset) => `${sha256(NodePath.join(directory, asset))}  ${asset}`)
    .join("\n");
  NodeFS.writeFileSync(NodePath.join(directory, "SHA256SUMS"), `${contents}\n`);
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  const [directory, version] = process.argv.slice(2);
  if (!directory || !version) {
    throw new Error("Usage: node scripts/verify-release-candidate.ts <directory> <version>");
  }
  verifyReleaseCandidate(NodePath.resolve(directory), version);
  console.log(`Verified stable release candidate ${version}.`);
}
