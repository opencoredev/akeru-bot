import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { sha256 } from "@noble/hashes/sha2";
import { parse, type ParseError } from "jsonc-parser";

export const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const decodeJsonOption = Schema.decodeUnknownOption(Schema.Json);

export const MAX_VSIX_BYTES = 20 * 1024 * 1024;

export const MAX_MANIFEST_BYTES = 256 * 1024;

export const MAX_THEMES_PER_EXTENSION = 40;

type ThemeContribution = Schema.JsonObject;

export function isRecord(value: Schema.Json | undefined): value is Schema.JsonObject {
  return Predicate.isObject(value);
}

export function shortHash(value: string): string {
  return [...sha256(new TextEncoder().encode(value))]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function openVsxThemeId(extensionId: string, source: string): string {
  return `ovx-theme-${shortHash(`${extensionId}:${source}`)}`;
}

export function themeContributions(manifest: Schema.JsonObject): ThemeContribution[] {
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : null;

  return Array.isArray(contributes?.themes) ? contributes.themes.filter(isRecord) : [];
}

export function manifestLicenseMatches(manifest: Schema.JsonObject, license: string): boolean {
  return (
    Predicate.isString(manifest.license) &&
    manifest.license.trim().toLowerCase() === license.toLowerCase()
  );
}

export function parseJsoncObject(source: string, description: string): Schema.JsonObject {
  const errors: ParseError[] = [];
  const decoded = decodeJsonOption(parse(source, errors, { allowTrailingComma: true }));

  if (errors.length > 0 || Option.isNone(decoded) || !isRecord(decoded.value)) {
    throw new Error(`${description} is not valid JSON.`);
  }

  return decoded.value;
}

export async function readCappedResponse(
  response: Response,
  limit: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");

  if (contentLength && Number(contentLength) > limit) throw new Error(tooLargeMessage);

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (bytes.byteLength > limit) throw new Error(tooLargeMessage);

    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      byteLength += value.byteLength;

      if (byteLength > limit) {
        await reader.cancel();
        throw new Error(tooLargeMessage);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}
