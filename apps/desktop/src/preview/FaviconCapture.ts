import {
  safeHttpOrigin,
  selectFaviconCandidates,
  parseInlineFavicon,
  readFaviconResponse,
} from "./FaviconSource.ts";
import { type FaviconCaptureResult, normalizeFaviconBuffer } from "./FaviconRasterizer.ts";
export { MAX_FAVICON_RESPONSE_BYTES } from "./FaviconSource.ts";
export { MAX_FAVICON_CANDIDATES } from "./FaviconSource.ts";
export { MAX_FAVICON_HTTP_URL_LENGTH } from "./FaviconSource.ts";
export { safeHttpOrigin } from "./FaviconSource.ts";
export { selectFaviconCandidates } from "./FaviconSource.ts";
export type { FaviconCaptureResult } from "./FaviconRasterizer.ts";

const FAVICON_CAPTURE_TIMEOUT_MS = 5_000;

export async function captureFavicon(input: {
  readonly webContents: Electron.WebContents;
  readonly pageUrl: string;
  readonly candidates: ReadonlyArray<string>;
  readonly signal: AbortSignal;
}): Promise<FaviconCaptureResult> {
  const pageOrigin = safeHttpOrigin(input.pageUrl);
  if (!pageOrigin) return { kind: "none" };
  const captureTimeout = AbortSignal.timeout(FAVICON_CAPTURE_TIMEOUT_MS);
  const captureSignal = AbortSignal.any([input.signal, captureTimeout]);

  for (const candidate of selectFaviconCandidates(input.candidates)) {
    if (captureSignal.aborted) {
      return input.signal.aborted ? { kind: "none" } : { kind: "timed-out" };
    }
    const captured = await captureCandidate({
      webContents: input.webContents,
      pageOrigin,
      candidate,
      signal: captureSignal,
    });
    if (captureSignal.aborted) {
      return input.signal.aborted ? { kind: "none" } : { kind: "timed-out" };
    }
    if (captured.kind === "captured" || captured.kind === "timed-out") return captured;
  }

  return { kind: "none" };
}

async function captureCandidate(input: {
  readonly webContents: Electron.WebContents;
  readonly pageOrigin: string;
  readonly candidate: string;
  readonly signal: AbortSignal;
}): Promise<FaviconCaptureResult> {
  try {
    const inline = parseInlineFavicon(input.candidate);
    if (inline) {
      return await normalizeFaviconBuffer(
        input.webContents,
        inline.mime,
        inline.buffer,
        input.signal,
      );
    }

    const candidateOrigin = safeHttpOrigin(input.candidate);
    if (!candidateOrigin) return { kind: "none" };
    const response = await input.webContents.session.fetch(input.candidate, {
      credentials: candidateOrigin === input.pageOrigin ? "include" : "omit",
      redirect: "error",
      signal: input.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "none" };
    }
    const buffer = await readFaviconResponse(response, input.signal);
    if (!buffer || input.signal.aborted) return { kind: "none" };
    const mime = response.headers.get("content-type")?.split(";", 1)[0] ?? null;
    return await normalizeFaviconBuffer(input.webContents, mime, buffer, input.signal);
  } catch {
    return { kind: "none" };
  }
}
