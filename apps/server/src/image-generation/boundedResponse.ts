/**
 * Image providers return base64 images inside JSON or event streams. Reading a
 * body through this cap keeps one oversized or runaway response from being
 * buffered, parsed, and decoded in full.
 */
export const MAX_IMAGE_RESPONSE_BYTES = 64 * 1024 * 1024;

export class ImageResponseTooLargeError extends Error {
  constructor(label: string) {
    super(`${label} returned a response larger than the image size limit.`);
    this.name = "ImageResponseTooLargeError";
  }
}

/** Reads a response body as text, failing once it exceeds `maxBytes`. */
export async function readBoundedText(
  response: Response,
  label: string,
  maxBytes: number = MAX_IMAGE_RESPONSE_BYTES,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ImageResponseTooLargeError(label);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ImageResponseTooLargeError(label);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}
