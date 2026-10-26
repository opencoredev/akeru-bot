import { CloudOAuthResult } from "@akeru/contracts";
import * as Schema from "effect/Schema";

const decodeResult = Schema.decodeUnknownSync(Schema.fromJsonString(CloudOAuthResult));

const encoder = new TextEncoder();

const decoder = new TextDecoder();

async function resultKey(state: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`oauth-result:${state}`));

  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** The stored state hash cannot recover this key; only the callback's secret state can. */
export async function sealOAuthResult(state: string, result: CloudOAuthResult) {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await resultKey(state),
    encoder.encode(JSON.stringify(result)),
  );

  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`;
}

export async function openOAuthResult(state: string, sealed: string) {
  const [nonce, ciphertext] = sealed.split(".");

  if (!nonce || !ciphertext) throw new Error("Invalid OAuth completion");

  const bytes = (value: string) =>
    Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(nonce) },
    await resultKey(state),
    bytes(ciphertext),
  );

  return decodeResult(decoder.decode(decrypted));
}
