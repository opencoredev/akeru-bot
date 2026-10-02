import * as Schema from "effect/Schema";
import { EnvironmentId } from "../baseSchemas.ts";
import {
  DesktopSshEnvironmentTargetSchema,
  DesktopSshEnvironmentBootstrapSchema,
  DesktopSshPasswordPromptCancelledResultSchema,
} from "./environment.ts";

export const DesktopSshEnvironmentEnsureOptionsSchema = Schema.Struct({
  issuePairingToken: Schema.optionalKey(Schema.Boolean),
});

export const DesktopSshEnvironmentEnsureInputSchema = Schema.Struct({
  target: DesktopSshEnvironmentTargetSchema,
  options: Schema.optionalKey(DesktopSshEnvironmentEnsureOptionsSchema),
});

export const DesktopSshEnvironmentEnsureResultSchema = Schema.Union([
  DesktopSshEnvironmentBootstrapSchema,
  DesktopSshPasswordPromptCancelledResultSchema,
]);

export const DesktopSshHttpBaseUrlInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
});

export const DesktopSshBearerRequestInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
  bearerToken: Schema.String,
});

export const DesktopSshBearerBootstrapInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
  credential: Schema.String,
});

export const DesktopSshPasswordPromptResolutionInputSchema = Schema.Struct({
  requestId: Schema.String,
  password: Schema.NullOr(Schema.String),
});

export const PersistedSavedEnvironmentRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  wsBaseUrl: Schema.String,
  httpBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  desktopSsh: Schema.optionalKey(DesktopSshEnvironmentTargetSchema),
});

export type PersistedSavedEnvironmentRecord = typeof PersistedSavedEnvironmentRecordSchema.Type;

export type DesktopServerExposureMode = "local-only" | "network-accessible";

export const DesktopServerExposureModeSchema = Schema.Literals([
  "local-only",
  "network-accessible",
]);

export interface DesktopServerExposureState {
  mode: DesktopServerExposureMode;
  endpointUrl: string | null;
  advertisedHost: string | null;
  tailscaleServeEnabled: boolean;
  tailscaleServePort: number;
}

export const DesktopServerExposureStateSchema = Schema.Struct({
  mode: DesktopServerExposureModeSchema,
  endpointUrl: Schema.NullOr(Schema.String),
  advertisedHost: Schema.NullOr(Schema.String),
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: Schema.Number,
});

export interface PickFolderOptions {
  initialPath?: string | null;
  // When set, the desktop dialog opens against the named backend's
  // filesystem instead of the primary's. Used by callers that already
  // know which local environment they're targeting (e.g. opening a
  // project that lives inside WSL). Omitting it keeps the historical
  // behavior so non-WSL users never see a different picker.
  targetEnvironmentId?: string;
}

export const PickFolderOptionsSchema = Schema.Struct({
  initialPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  targetEnvironmentId: Schema.optionalKey(Schema.String),
});

/**
 * A file returned by the desktop theme-file picker. Oversized files carry an
 * empty text so the renderer can reject them by size without the main
 * process ever holding their contents.
 */
export interface PickedThemeFile {
  name: string;
  size: number;
  text: string;
}

export const PickedThemeFileSchema = Schema.Struct({
  name: Schema.String,
  size: Schema.Number,
  text: Schema.String,
});

export interface DesktopWslDistro {
  name: string;
  isDefault: boolean;
  version: 1 | 2;
}

export const DesktopWslDistroSchema = Schema.Struct({
  name: Schema.String,
  isDefault: Schema.Boolean,
  version: Schema.Literals([1, 2]),
});

export interface DesktopWslState {
  // True when the user has opted the WSL backend in; the actual backend
  // process is registered with the desktop pool independently of this
  // flag and may take a moment to come up after the user enables it.
  enabled: boolean;
  // null means "track the current WSL default distro".
  distro: string | null;
  available: boolean;
  // When true (and `enabled` is also true) the desktop runs only the
  // WSL backend as the primary; the Windows-side Node backend is not
  // started. Toggling this requires an app restart because the
  // primary backend's spec is captured once at layer init.
  wslOnly: boolean;
  distros: readonly DesktopWslDistro[];
  // Reason the dual-mode WSL backend last failed preflight (no node, wrong
  // version, missing build tools), or null. Surfaced inline in Connections
  // settings. Always null in wsl-only mode — that path shows a dialog and
  // falls back to Windows instead.
  preflightError: string | null;
}

export const DesktopWslStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  distro: Schema.NullOr(Schema.String),
  available: Schema.Boolean,
  wslOnly: Schema.Boolean,
  distros: Schema.Array(DesktopWslDistroSchema),
  preflightError: Schema.NullOr(Schema.String),
});

/**
 * Renderer-facing snapshot of a desktop preview tab. Mirrors the main-process
 * PreviewTabState shape but uses serialisable primitives only.
 */
export type DesktopPreviewNavStatus =
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

/**
 * Emulated `prefers-color-scheme` for the guest page. "system" clears the
 * override so the page follows the OS appearance.
 */
export type DesktopPreviewColorScheme = "system" | "light" | "dark";

export const DesktopPreviewColorSchemeSchema: Schema.Codec<DesktopPreviewColorScheme> =
  Schema.Literals(["system", "light", "dark"]);

export const FAVICON_DATA_URL_MAX_LENGTH = 8192;

export const FAVICON_CAPTURED_AT_MAX = 8_640_000_000_000_000;

export interface DesktopPreviewFavicon {
  dataUrl: string;
  pageUrl: string;
  capturedAt: number;
}

export const DesktopPreviewFaviconSchema: Schema.Codec<DesktopPreviewFavicon> = Schema.Struct({
  dataUrl: Schema.String.check(
    Schema.isMaxLength(FAVICON_DATA_URL_MAX_LENGTH),
    Schema.isPattern(/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i),
  ),
  pageUrl: Schema.String.check(Schema.isMaxLength(2_048)),
  capturedAt: Schema.Number.check(
    Schema.isFinite(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(FAVICON_CAPTURED_AT_MAX),
  ),
});

export interface DesktopPreviewTabState {
  tabId: string;
  webContentsId: number | null;
  navStatus: DesktopPreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Current zoom factor (1.0 = 100%). */
  zoomFactor: number;
  /** Whether this tab is currently mirrored into a desktop picture-in-picture window. */
  pictureInPicture: boolean;
  colorScheme: DesktopPreviewColorScheme;
  /**
   * Whether the user has silenced this tab. Per tab rather than per origin, so
   * two tabs on the same site mute independently. Survives navigation and
   * webview swaps, but is dropped when the tab closes.
   */
  audioMuted: boolean;
  /**
   * Whether the guest is currently emitting audio. Observed from Chromium, and
   * independent of {@link audioMuted}: a muted tab that is playing still reports
   * `true`, which is what lets the tab strip distinguish "muted and making
   * sound" from "muted and silent".
   */
  audible: boolean;
  controller: "human" | "agent" | "none";
  favicon?: DesktopPreviewFavicon;
  updatedAt: string;
}

export const DesktopPreviewTabIdSchema = Schema.String.check(Schema.isTrimmed()).check(
  Schema.isNonEmpty(),
);

export const DesktopPreviewNavStatusSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("Idle") }),
  Schema.Struct({
    kind: Schema.Literal("Loading"),
    url: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("Success"),
    url: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("LoadFailed"),
    url: Schema.String,
    title: Schema.String,
    code: Schema.Number,
    description: Schema.String,
  }),
]);

export const DesktopPreviewTabStateSchema: Schema.Codec<DesktopPreviewTabState> = Schema.Struct({
  tabId: DesktopPreviewTabIdSchema,
  webContentsId: Schema.NullOr(Schema.Int),
  navStatus: DesktopPreviewNavStatusSchema,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  zoomFactor: Schema.Number,
  pictureInPicture: Schema.Boolean,
  colorScheme: DesktopPreviewColorSchemeSchema,
  audioMuted: Schema.Boolean,
  audible: Schema.Boolean,
  controller: Schema.Literals(["human", "agent", "none"]),
  favicon: Schema.optionalKey(DesktopPreviewFaviconSchema),
  updatedAt: Schema.String,
});

export interface DesktopPreviewPointerEvent {
  tabId: string;
  phase: "move" | "click";
  x: number;
  y: number;
  sequence: number;
  createdAt: string;
}

export const DesktopPreviewPointerEventSchema: Schema.Codec<DesktopPreviewPointerEvent> =
  Schema.Struct({
    tabId: DesktopPreviewTabIdSchema,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Number,
    y: Schema.Number,
    sequence: Schema.Int,
    createdAt: Schema.String,
  });

/**
 * Static config a renderer needs to mount a preview `<webview>`. Returned
 * atomically by `DesktopPreviewBridge.getPreviewConfig()` so the renderer
 * doesn't have to wait on three separate IPC round-trips before the webview
 * can attach.
 */
export interface DesktopPreviewWebviewConfig {
  /** `persist:akeru-preview` (or whatever the desktop chose). */
  partition: string;
  /**
   * Canonical `<webview webpreferences="...">` string. Encodes the security
   * posture (sandboxed but contextIsolation off so the picker preload can
   * read the page's React DevTools hook). Always present.
   */
  webPreferences: string;
  /**
   * Absolute `file://`-style URL to the picker preload bundle. Set to null
   * when the bundle isn't present (older builds, broken install) — the
   * renderer must then disable element-pick affordances.
   */
  preloadUrl: string | null;
}

export const DesktopPreviewWebviewConfigSchema: Schema.Codec<DesktopPreviewWebviewConfig> =
  Schema.Struct({
    partition: Schema.String,
    webPreferences: Schema.String,
    preloadUrl: Schema.NullOr(Schema.String),
  });

export interface DesktopPreviewAnnotationTheme {
  colorScheme: "light" | "dark";
  radius: string;
  background: string;
  foreground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  border: string;
  input: string;
  ring: string;
  fontSans: string;
  fontMono: string;
}

export const DesktopPreviewAnnotationThemeSchema: Schema.Codec<DesktopPreviewAnnotationTheme> =
  Schema.Struct({
    colorScheme: Schema.Literals(["light", "dark"]),
    radius: Schema.String,
    background: Schema.String,
    foreground: Schema.String,
    popover: Schema.String,
    popoverForeground: Schema.String,
    primary: Schema.String,
    primaryForeground: Schema.String,
    muted: Schema.String,
    mutedForeground: Schema.String,
    accent: Schema.String,
    accentForeground: Schema.String,
    border: Schema.String,
    input: Schema.String,
    ring: Schema.String,
    fontSans: Schema.String,
    fontMono: Schema.String,
  });

export interface DesktopPreviewRecordingFrame {
  tabId: string;
  data: string;
  width: number;
  height: number;
  receivedAt: string;
}

export const DesktopPreviewRecordingFrameSchema: Schema.Codec<DesktopPreviewRecordingFrame> =
  Schema.Struct({
    tabId: DesktopPreviewTabIdSchema,
    data: Schema.String,
    width: Schema.Number,
    height: Schema.Number,
    receivedAt: Schema.String,
  });

export interface DesktopPreviewRecordingArtifact {
  id: string;
  tabId: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export const DesktopPreviewRecordingArtifactSchema: Schema.Codec<DesktopPreviewRecordingArtifact> =
  Schema.Struct({
    id: Schema.String,
    tabId: DesktopPreviewTabIdSchema,
    path: Schema.String,
    mimeType: Schema.String,
    sizeBytes: Schema.Int,
    createdAt: Schema.String,
  });

export interface DesktopPreviewScreenshotArtifact {
  id: string;
  tabId: string;
  path: string;
  mimeType: "image/png";
  sizeBytes: number;
  createdAt: string;
}

export const DesktopPreviewScreenshotArtifactSchema: Schema.Codec<DesktopPreviewScreenshotArtifact> =
  Schema.Struct({
    id: Schema.String,
    tabId: DesktopPreviewTabIdSchema,
    path: Schema.String,
    mimeType: Schema.Literal("image/png"),
    sizeBytes: Schema.Int,
    createdAt: Schema.String,
  });
