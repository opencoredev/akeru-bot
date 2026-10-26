const encoder = new TextEncoder();

// 32 symbols so a random byte masked to 5 bits picks one without bias.
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

// No I, O, 0, or 1, so a code read aloud or retyped stays unambiguous.
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomSymbols(alphabet: string, length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));

  return Array.from(bytes, (byte) => alphabet[byte & 31]).join("");
}

/** 32 random bytes as base64url. Used for device codes, environment tokens, and OAuth state. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Public identifier such as `env_…` or `rt_…`. Not a secret. */
export function randomId(prefix: string): string {
  return `${prefix}_${randomSymbols(ID_ALPHABET, 20)}`;
}

/** Human-typed link code in the form `ABCD-EFGH`. */
export function createUserCode(): string {
  const symbols = randomSymbols(USER_CODE_ALPHABET, 8);

  return `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
}

/** Accepts `abcd efgh`, `ABCDEFGH`, or `ABCD-EFGH` and returns the canonical form. */
export function normalizeUserCode(input: string): string | null {
  const symbols = input.toUpperCase().replace(/[\s-]/g, "");

  if (symbols.length !== 8) return null;

  for (const symbol of symbols) {
    if (!USER_CODE_ALPHABET.includes(symbol)) return null;
  }

  return `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
}

/** Tokens and codes are stored only as this hash. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
