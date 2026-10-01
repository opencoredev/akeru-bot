import type {
  DesktopPreviewAnnotationTheme,
  DesktopPreviewColorScheme,
  DesktopPreviewFavicon,
  DesktopPreviewPointerEvent,
  PreviewAnnotationPayload,
  PreviewAnnotationRect,
  DesktopPreviewRecordingFrame,
  PreviewAutomationConsoleEntry,
  PreviewAutomationNetworkEntry,
} from "@akeru/contracts";

import { type BrowserWindow, type Rectangle } from "electron";

import type * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as Schema from "effect/Schema";
import type * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import { PNG } from "pngjs";

import { PreviewOperationError, type PreviewManagerError } from "./PreviewErrors.ts";

export type PreviewNavStatus =
  | { kind: "Idle" }
  | { kind: "Loading"; url: string; title: string }
  | { kind: "Success"; url: string; title: string }
  | {
      kind: "LoadFailed";
      url: string;
      title: string;
      code: number;
      description: string;
    };

export interface PreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  /** User intent to silence this tab. Re-applied to each guest that attaches. */
  audioMuted: boolean;
  /** Observed from Chromium. Stays true while a muted tab keeps playing. */
  audible: boolean;
  controller: "human" | "agent" | "none";
  favicon?: DesktopPreviewFavicon;
  updatedAt: string;
}

/** Discrete zoom levels mirroring Chrome's preset list. */
export const ZOOM_LEVELS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];

export const DEFAULT_ZOOM_FACTOR = 1.0;

export const ZOOM_EPSILON = 0.001;

export const MAX_EVALUATION_BYTES = 64_000;

export const MAX_VISIBLE_TEXT_LENGTH = 20_000;

export const MAX_INTERACTIVE_ELEMENTS = 200;

export const MAX_SCREENSHOT_WIDTH = 1280;

export const containsVisiblePngPixel = (data: Buffer): boolean => {
  try {
    const png = PNG.sync.read(data);

    for (let offset = 0; offset + 3 < png.data.byteLength; offset += 4) {
      const alpha = png.data[offset + 3]!;

      if (
        alpha !== 0 &&
        (png.data[offset]! !== 0 || png.data[offset + 1]! !== 0 || png.data[offset + 2]! !== 0)
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
};

export const scaleCaptureRect = (
  rect: Rectangle,
  windowBounds: Rectangle,
  contentBounds: Rectangle,
  thumbnailSize: { readonly width: number; readonly height: number },
): Rectangle => {
  const scaleX = thumbnailSize.width / windowBounds.width;
  const scaleY = thumbnailSize.height / windowBounds.height;

  return {
    x: Math.max(0, Math.round((contentBounds.x - windowBounds.x + rect.x) * scaleX)),
    y: Math.max(0, Math.round((contentBounds.y - windowBounds.y + rect.y) * scaleY)),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY)),
  };
};

export const RECORDING_FRAME_INTERVAL_MS = Math.ceil(1_000 / 12);

export const RECORDING_JPEG_QUALITY = 80;

export const PICTURE_IN_PICTURE_INITIAL_WIDTH = 480;

export const PICTURE_IN_PICTURE_INITIAL_HEIGHT = 320;

export const PICTURE_IN_PICTURE_MIN_WIDTH = 240;

export const PICTURE_IN_PICTURE_MIN_HEIGHT = 160;

export const PICTURE_IN_PICTURE_ASPECT_RATIO_EPSILON = 0.002;

export const DIAGNOSTIC_BUFFER_LIMIT = 200;

export const MAX_ARTIFACT_SITE_SLUG_LENGTH = 80;

export const AGENT_CURSOR_MOVE_MS = 160;

export const AGENT_CURSOR_CLICK_LEAD_MS = 40;

export const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const DEFAULT_ANNOTATION_THEME: DesktopPreviewAnnotationTheme = {
  colorScheme: "light",
  radius: "0.625rem",
  background: "white",
  foreground: "oklch(0.269 0 0)",
  popover: "white",
  popoverForeground: "oklch(0.269 0 0)",
  primary: "oklch(0.488 0.217 264)",
  primaryForeground: "white",
  muted: "rgb(0 0 0 / 4%)",
  mutedForeground: "oklch(0.556 0 0)",
  accent: "rgb(0 0 0 / 4%)",
  accentForeground: "oklch(0.269 0 0)",
  border: "rgb(0 0 0 / 8%)",
  input: "rgb(0 0 0 / 10%)",
  ring: "oklch(0.488 0.217 264)",
  fontSans: "system-ui, sans-serif",
  fontMono: "ui-monospace, monospace",
};

export const buildPreviewPictureInPictureDataUrl = (): string => {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    >
    <meta name="color-scheme" content="dark">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #111; }
      body { display: grid; place-items: center; }
      img { width: 100%; height: 100%; object-fit: contain; user-select: none; -webkit-user-drag: none; }
    </style>
  </head>
  <body>
    <img id="preview-frame" alt="Live browser preview">
    <script>
      const frame = document.getElementById("preview-frame");
      window.previewPictureInPicture.onFrame((next) => {
        frame.src = "data:image/jpeg;base64," + next.data;
      });
    </script>
  </body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
};

export const fitPictureInPictureContentSize = (
  current: ReadonlyArray<number>,
  aspectRatio: number,
): readonly [width: number, height: number] => {
  const currentWidth = Math.max(1, current[0] ?? PICTURE_IN_PICTURE_INITIAL_WIDTH);
  const currentHeight = Math.max(1, current[1] ?? PICTURE_IN_PICTURE_INITIAL_HEIGHT);
  const currentArea = currentWidth * currentHeight;
  let width = Math.sqrt(currentArea * aspectRatio);
  let height = width / aspectRatio;

  const minimumScale = Math.max(
    1,
    PICTURE_IN_PICTURE_MIN_WIDTH / width,
    PICTURE_IN_PICTURE_MIN_HEIGHT / height,
  );

  width *= minimumScale;
  height *= minimumScale;

  return [Math.round(width), Math.round(height)];
};

export const artifactSiteSlug = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);

    const slug = url.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_ARTIFACT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");

    return slug || "site";
  } catch {
    return "site";
  }
};

export interface CdpEvaluationResult {
  readonly result?: {
    readonly value?: unknown;
    readonly description?: string;
  };
  readonly exceptionDetails?: {
    readonly text?: string;
    readonly exception?: { readonly description?: string };
  };
}

export const normalizeCaptureRect = (value: unknown): PreviewAnnotationRect | null => {
  if (typeof value !== "object" || value === null) return null;
  const rect = value as Record<string, unknown>;
  const x = rect["x"];
  const y = rect["y"];
  const width = rect["width"];
  const height = rect["height"];

  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.max(1, Math.ceil(width)),
    height: Math.max(1, Math.ceil(height)),
  };
};

export const captureAnnotationScreenshot = (
  tabId: string,
  wc: Electron.WebContents,
  cropRect: PreviewAnnotationRect | null,
): Effect.Effect<PreviewAnnotationPayload["screenshot"], PreviewManagerError> =>
  Effect.tryPromise({
    try: () =>
      wc.capturePage(
        cropRect
          ? {
              x: cropRect.x,
              y: cropRect.y,
              width: cropRect.width,
              height: cropRect.height,
            }
          : undefined,
      ),
    catch: (cause) =>
      new PreviewOperationError({
        operation: "captureAnnotationScreenshot",
        tabId,
        webContentsId: wc.id,
        cause,
      }),
  }).pipe(
    Effect.map((image) => {
      const size = image.getSize();

      return {
        dataUrl: image.toDataURL(),
        width: size.width,
        height: size.height,
        cropRect: cropRect ?? { x: 0, y: 0, width: size.width, height: size.height },
      };
    }),
  );

export const findZoomStep = (current: number): number => {
  const index = ZOOM_LEVELS.findIndex(
    (level) => Math.abs(level - current) < ZOOM_EPSILON || level > current,
  );

  if (index < 0) return ZOOM_LEVELS.length - 1;

  return Math.abs(ZOOM_LEVELS[index]! - current) < ZOOM_EPSILON ? index : index - 1;
};

/**
 * Clamp a client-supplied zoom factor onto the discrete ladder. The setting is
 * chosen from the same ladder, but it arrives over IPC from a schema that only
 * guarantees a positive number, so an out-of-band value snaps to the nearest
 * step rather than leaving the guest at a zoom the zoom controls can't reach.
 */
export const normalizeZoomFactor = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ZOOM_FACTOR;
  let closest = ZOOM_LEVELS[0]!;

  for (const level of ZOOM_LEVELS) {
    if (Math.abs(level - value) < Math.abs(closest - value)) closest = level;
  }

  return closest;
};

export const nextZoomLevel = (current: number, direction: "in" | "out"): number => {
  const step = findZoomStep(current);

  if (direction === "in") {
    return ZOOM_LEVELS[Math.min(step + 1, ZOOM_LEVELS.length - 1)] ?? current;
  }

  return ZOOM_LEVELS[Math.max(step - 1, 0)] ?? current;
};

export type Listener = (tabId: string, state: PreviewTabState) => Effect.Effect<void>;

export type RecordingFrameListener = (frame: DesktopPreviewRecordingFrame) => Effect.Effect<void>;

export type PreviewInputSignal =
  | { readonly kind: "pointer"; readonly x: number; readonly y: number; readonly button: number }
  | { readonly kind: "key"; readonly key: string; readonly code: string };

export interface ManagedListeners {
  readonly attachmentId: symbol;
  readonly cancelFaviconCapture: () => void;
  readonly scope: Scope.Closeable;
  readonly webContents: Electron.WebContents;
}

export type FrameCaptureConsumer = "picture-in-picture" | "recording";

export interface FrameCaptureSession {
  readonly scope: Scope.Closeable;
  readonly consumers: ReadonlySet<FrameCaptureConsumer>;
  readonly lastPictureInPictureFrame: Buffer | null;
}

export interface PictureInPictureSession {
  readonly window: BrowserWindow;
  readonly webContentsId: number;
  readonly ready: Deferred.Deferred<void, PreviewManagerError>;
  readonly initializationScope: Scope.Closeable;
}

export interface PickSession {
  readonly cancel: Effect.Effect<void>;
}

export interface BrowserControlSession {
  readonly webContentsId: number;
  // Pins the WebContents' Debugger wrapper for the session's lifetime.
  // Electron's Debugger is GC-managed but registered with Chromium as a raw
  // DevToolsAgentHostClient pointer; collecting it while attached crashes the
  // browser process (electron/electron#53376). Detach must also go through
  // this reference: `wc.debugger` throws once the WebContents is destroyed.
  readonly debugger: Electron.Debugger;
  readonly semaphore: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => void;
}

export interface BrowserDiagnostics {
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly requests: ReadonlyMap<string, { url: string; method: string }>;
}

export type PointerEventListener = (event: DesktopPreviewPointerEvent) => Effect.Effect<void>;

export interface ExpectedAgentInput {
  readonly signal: PreviewInputSignal;
  readonly expiresAt: number;
}

export const isPreviewRefreshShortcut = (input: Electron.Input): boolean =>
  input.type === "keyDown" &&
  input.key.toLowerCase() === "r" &&
  (input.meta || input.control) &&
  !input.shift &&
  !input.alt;

export const isPreviewEditingShortcut = (
  input: Electron.Input,
  platform: NodeJS.Platform,
): boolean => {
  const isMac = platform === "darwin";

  if (isMac ? !input.meta || input.control : !input.control || input.meta) return false;

  const key = input.key.toLowerCase();

  // Option changes the DOM key for macOS Paste and Match Style (for example, to ◊).
  if (isMac && input.alt && input.shift && input.code === "KeyV") return true;

  if (key === "v" && input.shift) return input.alt === isMac;

  if (input.alt) return false;

  if (key === "z") return !input.shift || platform !== "win32";

  if (input.shift) return false;

  return (
    key === "a" ||
    key === "c" ||
    key === "v" ||
    key === "x" ||
    (key === "y" && platform === "win32")
  );
};

export const isPreviewInputSignal = (value: unknown): value is PreviewInputSignal => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;

  if (value.kind === "pointer") {
    return (
      "x" in value &&
      typeof value.x === "number" &&
      "y" in value &&
      typeof value.y === "number" &&
      "button" in value &&
      typeof value.button === "number"
    );
  }

  return (
    value.kind === "key" &&
    "key" in value &&
    typeof value.key === "string" &&
    "code" in value &&
    typeof value.code === "string"
  );
};

export const inputSignalsMatch = (left: PreviewInputSignal, right: PreviewInputSignal): boolean => {
  if (left.kind !== right.kind) return false;

  if (left.kind === "pointer" && right.kind === "pointer") {
    return (
      Math.abs(left.x - right.x) <= 1 &&
      Math.abs(left.y - right.y) <= 1 &&
      left.button === right.button
    );
  }

  return (
    left.kind === "key" &&
    right.kind === "key" &&
    left.key === right.key &&
    left.code === right.code
  );
};

export type SendCommand = (
  method: string,
  commandParams?: Record<string, unknown>,
) => Effect.Effect<unknown, PreviewManagerError>;
