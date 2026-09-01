// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated temporary release directories.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it } from "vite-plus/test";

import { verifyReleaseCandidate, writeReleaseChecksums } from "./verify-release-candidate.ts";

const version = "1.2.3";
const assets = [
  `Akeru-Bot-${version}-arm64.dmg`,
  `Akeru-Bot-${version}-arm64-mac.zip`,
  `Akeru-Bot-${version}-x64.exe`,
  `Akeru-Bot-${version}-x64.exe.blockmap`,
  `Akeru-Bot-${version}-x86_64.AppImage`,
  `Akeru-Bot-${version}-x86_64.AppImage.blockmap`,
  "latest-mac.yml",
  "latest.yml",
  "latest-linux.yml",
] as const;

function fixture(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-release-verify-"));
  for (const asset of assets) NodeFS.writeFileSync(NodePath.join(directory, asset), asset);
  writeReleaseChecksums(directory, version);
  return directory;
}

describe("verifyReleaseCandidate", () => {
  it("accepts the exact stable asset set and generated checksums", () => {
    const directory = fixture();
    try {
      NodeAssert.doesNotThrow(() => verifyReleaseCandidate(directory, version));
    } finally {
      NodeFS.rmSync(directory, { recursive: true });
    }
  });

  it("rejects a checksum mismatch", () => {
    const directory = fixture();
    try {
      NodeFS.appendFileSync(NodePath.join(directory, assets[0]), "tampered");
      NodeAssert.throws(() => verifyReleaseCandidate(directory, version), /SHA256 mismatch/);
    } finally {
      NodeFS.rmSync(directory, { recursive: true });
    }
  });

  it("rejects nightly versions and assets", () => {
    const directory = fixture();
    try {
      NodeAssert.throws(
        () => verifyReleaseCandidate(directory, "1.2.3-nightly.1"),
        /Stable release version must be plain semver/,
      );
      NodeFS.writeFileSync(NodePath.join(directory, "latest-nightly.yml"), "nightly");
      NodeAssert.throws(
        () => verifyReleaseCandidate(directory, version),
        /Release assets do not match/,
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true });
    }
  });
});
