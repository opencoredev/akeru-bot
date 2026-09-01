const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_BUFFERED_SCREENSHOTS_PER_THREAD = 4;
const MAX_BUFFERED_THREADS = 100;

const screenshotsByThread = new Map<string, ReadonlyArray<Buffer>>();

function screenshotBytes(result: unknown): Buffer | null {
  if (typeof result !== "object" || result === null || !("screenshot" in result)) return null;
  const screenshot = result.screenshot;
  if (
    typeof screenshot !== "object" ||
    screenshot === null ||
    !("mimeType" in screenshot) ||
    screenshot.mimeType !== "image/png" ||
    !("data" in screenshot) ||
    typeof screenshot.data !== "string"
  ) {
    return null;
  }
  const bytes = Buffer.from(screenshot.data, "base64");
  return bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ? bytes : null;
}

export function stagePreviewSnapshot(threadId: string, result: unknown): void {
  const bytes = screenshotBytes(result);
  if (!bytes) return;
  const queued = [...(screenshotsByThread.get(threadId) ?? []), bytes].slice(
    -MAX_BUFFERED_SCREENSHOTS_PER_THREAD,
  );
  screenshotsByThread.delete(threadId);
  screenshotsByThread.set(threadId, queued);
  while (screenshotsByThread.size > MAX_BUFFERED_THREADS) {
    const oldest = screenshotsByThread.keys().next().value;
    if (oldest === undefined) break;
    screenshotsByThread.delete(oldest);
  }
}

export function takePreviewSnapshot(threadId: string): Buffer | null {
  const queued = screenshotsByThread.get(threadId);
  if (!queued || queued.length === 0) return null;
  const [first, ...remaining] = queued;
  if (remaining.length === 0) screenshotsByThread.delete(threadId);
  else screenshotsByThread.set(threadId, remaining);
  return first ?? null;
}
