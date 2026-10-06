const encoder = new TextEncoder();

async function key(secret: string) {
  if (!secret) throw new Error("Link delivery secret is missing");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`link-delivery:${secret}`));

  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts the short-lived handoff using a Worker secret, independent of the device code. */
export async function sealLinkToken(secret: string, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(secret),
    encoder.encode(token),
  );

  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`;
}

export async function openLinkToken(secret: string, sealed: string) {
  const [nonce, ciphertext] = sealed.split(".");

  if (!nonce || !ciphertext) throw new Error("Invalid link delivery");

  const bytes = (value: string) =>
    Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(nonce) },
    await key(secret),
    bytes(ciphertext),
  );

  return new TextDecoder().decode(decrypted);
}
