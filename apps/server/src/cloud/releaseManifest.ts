import * as NodeCrypto from "node:crypto";

/** The pinned Ed25519 key that signs every Akeru Remote release manifest. */
export const RELEASE_MANIFEST_KEY = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAr6AVDZl+P/T3TxY0EbpuMaNCImQ7EKTQYZc81ozkh+E=",
  "-----END PUBLIC KEY-----",
].join("\n");

/**
 * The archive's SHA-256 from a release manifest signed by `key`. Throws when the signature does
 * not match or the manifest does not list the archive, so an unsigned archive is never trusted.
 */
export function signedArchiveChecksum(input: {
  readonly manifest: Uint8Array;
  readonly signature: Uint8Array;
  readonly archiveName: string;
  readonly key?: string;
}): string {
  if (
    !NodeCrypto.verify(null, input.manifest, input.key ?? RELEASE_MANIFEST_KEY, input.signature)
  ) {
    throw new Error("The release manifest signature does not match the pinned Akeru release key.");
  }
  const expected = new TextDecoder()
    .decode(input.manifest)
    .split(/\r?\n/u)
    .map((line) => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/iu))
    .find((match) => match?.[2] === input.archiveName)?.[1];
  if (!expected) throw new Error(`Release checksum is missing for ${input.archiveName}.`);
  return expected.toLowerCase();
}
