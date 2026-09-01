#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Release verification runs before an Effect runtime exists.

import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export function expectedReleaseAssetNames(version: string): readonly string[] {
  return [
    `Akeru-Bot-${version}-arm64.dmg`,
    `Akeru-Bot-${version}-arm64.zip`,
    `Akeru-Bot-${version}-x64.exe`,
    `Akeru-Bot-${version}-x64.exe.blockmap`,
    `Akeru-Bot-${version}-x64.AppImage`,
    "latest-mac.yml",
    "latest.yml",
    "latest-linux.yml",
    `akeru-bot-${version}.tgz`,
  ];
}

export async function verifyReleaseAssets(directory: string, version: string): Promise<string> {
  const expected = expectedReleaseAssetNames(version).toSorted();
  const actual = (await NodeFSP.readdir(directory))
    .filter((name) => name !== "SHA256SUMS")
    .toSorted();
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(
      `Release assets differ.\nExpected:\n${expected.join("\n")}\nActual:\n${actual.join("\n")}`,
    );
  }

  const sums: string[] = [];
  for (const name of actual) {
    const path = NodePath.join(directory, name);
    if (!(await NodeFSP.stat(path)).isFile())
      throw new Error(`Release asset is not a file: ${name}`);
    sums.push(
      `${NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(path))
        .digest("hex")}  ${name}`,
    );
  }
  const contents = `${sums.join("\n")}\n`;
  await NodeFSP.writeFile(NodePath.join(directory, "SHA256SUMS"), contents);

  for (const line of contents.trimEnd().split("\n")) {
    const [hash, name] = line.split("  ");
    if (!name) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    const actualHash = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(NodePath.join(directory, NodePath.basename(name))))
      .digest("hex");
    if (hash !== actualHash) throw new Error(`SHA-256 verification failed: ${name}`);
  }
  return contents;
}

if (import.meta.main) {
  const [directory, version] = process.argv.slice(2);
  if (!directory || !version) throw new Error("Usage: verify-release-assets <directory> <version>");
  await verifyReleaseAssets(directory, version);
}
