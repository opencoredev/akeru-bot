import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import { signedArchiveChecksum } from "./releaseManifest.ts";

const keys = NodeCrypto.generateKeyPairSync("ed25519");
const key = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const checksum = "B".repeat(64);
const manifest = new TextEncoder().encode(
  `${"c".repeat(64)}  Akeru-Remote-1.1.0-linux-x64.tar.gz\n${checksum} *Akeru-Remote-1.1.0-win32-x64.zip\n`,
);
const signature = NodeCrypto.sign(null, manifest, keys.privateKey);

describe("signedArchiveChecksum", () => {
  it("returns the archive checksum from a signed manifest", () => {
    expect(
      signedArchiveChecksum({
        manifest,
        signature,
        archiveName: "Akeru-Remote-1.1.0-win32-x64.zip",
        key,
      }),
    ).toBe(checksum.toLowerCase());
  });

  it("rejects a tampered manifest", () => {
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(manifest).replace(checksum, "d".repeat(64)),
    );
    expect(() =>
      signedArchiveChecksum({
        manifest: tampered,
        signature,
        archiveName: "Akeru-Remote-1.1.0-win32-x64.zip",
        key,
      }),
    ).toThrow("signature does not match");
  });

  it("rejects a manifest signed by another key", () => {
    expect(() =>
      signedArchiveChecksum({
        manifest,
        signature,
        archiveName: "Akeru-Remote-1.1.0-win32-x64.zip",
      }),
    ).toThrow("signature does not match");
  });

  it("rejects an archive the manifest does not list", () => {
    expect(() =>
      signedArchiveChecksum({
        manifest,
        signature,
        archiveName: "Akeru-Remote-1.1.0-win32-arm64.zip",
        key,
      }),
    ).toThrow("Release checksum is missing");
  });
});
