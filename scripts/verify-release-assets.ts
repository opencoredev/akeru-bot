#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

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
  const actual = (await readdir(directory))
    .filter((name) => name !== "SHA256SUMS")
    .toSorted();
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(`Release assets differ.\nExpected:\n${expected.join("\n")}\nActual:\n${actual.join("\n")}`);
  }

  const sums: string[] = [];
  for (const name of actual) {
    const path = join(directory, name);
    if (!(await stat(path)).isFile()) throw new Error(`Release asset is not a file: ${name}`);
    sums.push(`${createHash("sha256").update(await readFile(path)).digest("hex")}  ${name}`);
  }
  const contents = `${sums.join("\n")}\n`;
  await writeFile(join(directory, "SHA256SUMS"), contents);

  for (const line of contents.trimEnd().split("\n")) {
    const [hash, name] = line.split("  ");
    const actualHash = createHash("sha256")
      .update(await readFile(join(directory, basename(name))))
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
