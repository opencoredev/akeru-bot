import * as Predicate from "effect/Predicate";
import { FAVICON_DATA_URL_MAX_LENGTH } from "@akeru/contracts";
import { MAX_FAVICON_RESPONSE_BYTES } from "./FaviconSource.ts";
import {
  sourceDimensions,
  safeDimensions,
  type ImageDimensions,
  MAX_FAVICON_SOURCE_PIXELS,
} from "./FaviconDimensions.ts";

export const FAVICON_RASTER_WORLD_ID = 1001;

export const FAVICON_RASTER_TIMEOUT_MS = 1_000;

export interface RasterizationGate {
  generation: number;
  launchAllowed?: Promise<void>;
}

export const rasterizationGates = new WeakMap<Electron.WebContents, RasterizationGate>();

export async function waitForRasterLaunch(
  previous: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", finish);
      resolve();
    };

    signal.addEventListener("abort", finish, { once: true });
    void previous.then(finish);
  });
}

export type FaviconCaptureResult =
  | { readonly kind: "captured"; readonly dataUrl: string }
  | { readonly kind: "none" }
  | { readonly kind: "timed-out" };

export type RasterizationResult =
  | { readonly kind: "completed"; readonly value: unknown }
  | { readonly kind: "timed-out" };

export async function normalizeFaviconBuffer(
  webContents: Electron.WebContents,
  mime: string | null,
  buffer: Buffer,
  signal: AbortSignal,
): Promise<FaviconCaptureResult> {
  const declaredMime = mime?.trim().toLowerCase() || null;

  const normalizedMime =
    declaredMime === "application/x-icon"
      ? "image/x-icon"
      : declaredMime === "application/octet-stream" || declaredMime === "binary/octet-stream"
        ? null
        : declaredMime;

  const dimensions = sourceDimensions(buffer);

  if (
    (normalizedMime !== null && !/^image\/[a-z0-9.+-]+$/i.test(normalizedMime)) ||
    normalizedMime === "image/svg+xml" ||
    buffer.byteLength > MAX_FAVICON_RESPONSE_BYTES ||
    !safeDimensions(dimensions)
  ) {
    return { kind: "none" };
  }

  const rasterized = await rasterizeFavicon(
    webContents,
    normalizedMime,
    buffer,
    dimensions,
    signal,
  );

  if (rasterized.kind === "timed-out") return rasterized;

  return Predicate.isString(rasterized.value) &&
    rasterized.value.startsWith("data:image/png;base64,") &&
    rasterized.value.length <= FAVICON_DATA_URL_MAX_LENGTH
    ? { kind: "captured", dataUrl: rasterized.value }
    : { kind: "none" };
}

export async function rasterizeFavicon(
  webContents: Electron.WebContents,
  mime: string | null,
  buffer: Buffer,
  dimensions: ImageDimensions,
  signal: AbortSignal,
): Promise<RasterizationResult> {
  const gate = rasterizationGates.get(webContents) ?? { generation: 0 };
  rasterizationGates.set(webContents, gate);
  const generation = ++gate.generation;
  const previousLaunchAllowed = gate.launchAllowed;

  if (previousLaunchAllowed) {
    await waitForRasterLaunch(previousLaunchAllowed, signal);
  }

  if (signal.aborted || generation !== gate.generation) {
    return { kind: "completed", value: null };
  }

  const payload = buffer.toString("base64");
  const blobType = mime ?? "";
  const scale = Math.min(32 / dimensions.width, 32 / dimensions.height);
  const decodeWidth = Math.max(1, Math.round(dimensions.width * scale));
  const decodeHeight = Math.max(1, Math.round(dimensions.height * scale));
  const drawX = (32 - decodeWidth) / 2;
  const drawY = (32 - decodeHeight) / 2;

  const code = `
    (() => {
      const rasterize = async () => {
        try {
          const source = Uint8Array.from(atob("${payload}"), (char) => char.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([source], { type: "${blobType}" }), {
            resizeWidth: ${decodeWidth},
            resizeHeight: ${decodeHeight},
            resizeQuality: "high",
          });
          try {
            if (bitmap.width <= 0 || bitmap.height <= 0 || bitmap.width * bitmap.height > ${MAX_FAVICON_SOURCE_PIXELS}) {
              return null;
            }
            const canvas = new OffscreenCanvas(32, 32);
            const context = canvas.getContext("2d");
            if (!context) return null;
            context.drawImage(bitmap, ${drawX}, ${drawY}, ${decodeWidth}, ${decodeHeight});
            const blob = await canvas.convertToBlob({ type: "image/png" });
            const output = new Uint8Array(await blob.arrayBuffer());
            let binary = "";
            for (const byte of output) binary += String.fromCharCode(byte);
            return "data:image/png;base64," + btoa(binary);
          } finally {
            bitmap.close();
          }
        } catch {
          return null;
        }
      };
      return rasterize();
    })()
  `;

  const execution = webContents.executeJavaScriptInIsolatedWorld(FAVICON_RASTER_WORLD_ID, [
    { code },
  ]);

  const result = new Promise<RasterizationResult>((resolve, reject) => {
    // Electron cannot cancel isolated-world execution. This timeout ends only
    // the logical attempt; renderer work may finish after a newer attempt starts.
    const timeout = AbortSignal.timeout(FAVICON_RASTER_TIMEOUT_MS);
    let settled = false;

    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      timeout.removeEventListener("abort", onTimeout);
      signal.removeEventListener("abort", onAbort);
      complete();
    };

    const onTimeout = () => {
      finish(() => resolve({ kind: "timed-out" }));
    };

    const onAbort = () => {
      finish(() => resolve({ kind: "completed", value: null }));
    };

    timeout.addEventListener("abort", onTimeout, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    void execution.then(
      (value) => {
        finish(() => resolve({ kind: "completed", value }));
      },
      (cause: unknown) => {
        finish(() => reject(cause));
      },
    );

    if (signal.aborted) onAbort();
  });

  // The logical timeout does not cancel Electron's renderer work. Keep the
  // gate closed until that physical execution actually settles.
  const launchAllowed = execution.then(
    () => undefined,
    () => undefined,
  );

  gate.launchAllowed = launchAllowed;
  void launchAllowed.then(() => {
    if (gate.launchAllowed === launchAllowed) delete gate.launchAllowed;
  });

  return await result;
}
