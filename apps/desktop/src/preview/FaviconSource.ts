export const MAX_FAVICON_RESPONSE_BYTES = 100_000;

export const MAX_FAVICON_CANDIDATES = 8;

export const MAX_FAVICON_HTTP_URL_LENGTH = 2_048;

export const MAX_FAVICON_CANDIDATE_INPUT_UNITS = 262_144;

export const MIN_FAVICON_CANDIDATE_INPUT_UNITS = 256;

export const MAX_FAVICON_INLINE_URL_LENGTH = Math.ceil((MAX_FAVICON_RESPONSE_BYTES * 4) / 3) + 128;

export function safeHttpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function selectFaviconCandidates(candidates: ReadonlyArray<string>): ReadonlyArray<string> {
  const selected: string[] = [];
  const seen = new Set<string>();
  let inputUnits = 0;
  for (const candidate of candidates) {
    // Charge a minimum per entry so a large array of tiny malformed values is bounded too.
    inputUnits += Math.max(MIN_FAVICON_CANDIDATE_INPUT_UNITS, candidate.length);
    if (inputUnits > MAX_FAVICON_CANDIDATE_INPUT_UNITS) break;
    if (!isSupportedFaviconUrl(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    selected.push(candidate);
    if (selected.length === MAX_FAVICON_CANDIDATES) break;
  }
  return selected;
}

export async function readFaviconResponse(
  response: Response,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_FAVICON_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength <= MAX_FAVICON_RESPONSE_BYTES ? buffer : null;
  }

  const reader = response.body.getReader();
  const cancelForAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelForAbort, { once: true });
  if (signal.aborted) cancelForAbort();
  const chunks: Buffer[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, byteLength);
      byteLength += next.value.byteLength;
      if (byteLength > MAX_FAVICON_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    signal.removeEventListener("abort", cancelForAbort);
    reader.releaseLock();
  }
}

export function isSupportedFaviconUrl(url: string): boolean {
  if (url.length > MAX_FAVICON_INLINE_URL_LENGTH) return false;
  if (/^data:/i.test(url)) return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(url);
  try {
    const protocol = new URL(url).protocol;
    return (
      (protocol === "http:" || protocol === "https:") && url.length <= MAX_FAVICON_HTTP_URL_LENGTH
    );
  } catch {
    return false;
  }
}

export function decodeInlineFaviconPayload(payload: string): Buffer | null {
  const decoded = Buffer.allocUnsafe(Buffer.byteLength(payload));
  let inputOffset = 0;
  let outputOffset = 0;
  while (inputOffset < payload.length) {
    const escapeOffset = payload.indexOf("%", inputOffset);
    const literalEnd = escapeOffset === -1 ? payload.length : escapeOffset;
    outputOffset += decoded.write(payload.slice(inputOffset, literalEnd), outputOffset, "utf8");
    if (escapeOffset === -1) break;
    const hex = payload.slice(escapeOffset + 1, escapeOffset + 3);
    if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
    decoded[outputOffset] = Number.parseInt(hex, 16);
    outputOffset += 1;
    inputOffset = escapeOffset + 3;
  }
  return decoded.subarray(0, outputOffset);
}

export function parseInlineFavicon(
  url: string,
): { readonly buffer: Buffer; readonly mime: string } | null {
  if (url.length > MAX_FAVICON_INLINE_URL_LENGTH) return null;
  const match = /^data:(image\/[a-z0-9.+-]+)((?:;[^,]*)?),(.*)$/is.exec(url);
  if (!match) return null;
  const mime = match[1]?.toLowerCase();
  const parameters = match[2]
    ?.split(";")
    .filter(Boolean)
    .map((parameter) => parameter.toLowerCase());
  const payload = match[3];
  if (!mime || !parameters || !payload) return null;
  const base64 = parameters.at(-1) === "base64";
  if (parameters.includes("base64") && !base64) return null;

  let buffer: Buffer;
  try {
    if (base64) {
      if (!/^[a-z0-9+/]*={0,2}$/i.test(payload) || payload.length % 4 === 1) return null;
      buffer = Buffer.from(payload, "base64");
      if (buffer.toString("base64").replace(/=+$/, "") !== payload.replace(/=+$/, "")) {
        return null;
      }
    } else {
      const decoded = decodeInlineFaviconPayload(payload);
      if (!decoded) return null;
      buffer = decoded;
    }
  } catch {
    return null;
  }

  return buffer.byteLength > 0 && buffer.byteLength <= MAX_FAVICON_RESPONSE_BYTES
    ? { buffer, mime }
    : null;
}
