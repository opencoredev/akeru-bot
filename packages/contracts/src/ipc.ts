import {
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from "./previewAutomation/input.ts";
import { PreviewAutomationSnapshot } from "./previewAutomation/snapshot.ts";
import { PreviewAutomationStatus } from "./previewAutomation/targets.ts";
import { EnvironmentId } from "./baseSchemas.ts";
import { AuthAccessTokenResult, AuthSessionState, AuthWebSocketTicketResult } from "./auth.ts";
import { AdvertisedEndpoint } from "./remoteAccess.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { type ClientSettings } from "./settings/client.ts";
import {
  type ContextMenuItem,
  type QuitShortcutHintEvent,
  type DesktopTheme,
  type DesktopUpdateChannel,
  type DesktopAppBranding,
  type DesktopUpdateState,
} from "./ipc/app.ts";
import {
  type DesktopUpdateActionResult,
  type DesktopUpdateCheckResult,
  type DesktopEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type DesktopDiscoveredSshHost,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshPasswordPromptRequest,
} from "./ipc/environment.ts";
import {
  type DesktopServerExposureMode,
  type DesktopServerExposureState,
  type PickFolderOptions,
  type PickedThemeFile,
  type DesktopWslState,
  type DesktopPreviewColorScheme,
  type DesktopPreviewTabState,
  type DesktopPreviewPointerEvent,
  type DesktopPreviewWebviewConfig,
  type DesktopPreviewAnnotationTheme,
  type DesktopPreviewRecordingFrame,
  type DesktopPreviewRecordingArtifact,
  type DesktopPreviewScreenshotArtifact,
} from "./ipc/preview.ts";
import { type PreviewAnnotationSubmissionResult } from "./ipc/annotations.ts";
import { type DesktopPreviewTabDefaults } from "./ipc/previewAutomation.ts";

export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  /**
   * The OS locale as a BCP-47 tag, which the renderer cannot read for itself:
   * the packaged app ships only the `en-US` Chromium locale pak, so
   * `navigator.language` and the default `Intl` locale are pinned to `en-US`
   * regardless of OS settings.
   */
  getSystemLocale?: () => string | null;
  // One bootstrap per pool instance currently registered with bootstrap
  // info (omits instances whose backend hasn't produced a config yet).
  // The primary backend is identified by id === PRIMARY_LOCAL_ENVIRONMENT_ID.
  getLocalEnvironmentBootstraps: () => readonly DesktopEnvironmentBootstrap[];
  getLocalEnvironmentBearerToken: () => Promise<string>;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  getConnectionCatalog?: () => Promise<string | null>;
  setConnectionCatalog?: (catalog: string) => Promise<boolean>;
  clearConnectionCatalog?: () => Promise<void>;
  discoverSshHosts: () => Promise<readonly DesktopDiscoveredSshHost[]>;
  ensureSshEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { issuePairingToken?: boolean },
  ) => Promise<DesktopSshEnvironmentBootstrap>;
  disconnectSshEnvironment: (target: DesktopSshEnvironmentTarget) => Promise<void>;
  fetchSshEnvironmentDescriptor: (httpBaseUrl: string) => Promise<ExecutionEnvironmentDescriptor>;
  bootstrapSshBearerSession: (
    httpBaseUrl: string,
    credential: string,
  ) => Promise<AuthAccessTokenResult>;
  fetchSshSessionState: (httpBaseUrl: string, bearerToken: string) => Promise<AuthSessionState>;
  issueSshWebSocketTicket: (
    httpBaseUrl: string,
    bearerToken: string,
  ) => Promise<AuthWebSocketTicketResult>;
  onSshPasswordPrompt: (listener: (request: DesktopSshPasswordPromptRequest) => void) => () => void;
  resolveSshPasswordPrompt: (requestId: string, password: string | null) => Promise<void>;
  getServerExposureState: () => Promise<DesktopServerExposureState>;
  setServerExposureMode: (mode: DesktopServerExposureMode) => Promise<DesktopServerExposureState>;
  setTailscaleServeEnabled: (input: {
    readonly enabled: boolean;
    readonly port?: number;
  }) => Promise<DesktopServerExposureState>;
  getAdvertisedEndpoints: () => Promise<readonly AdvertisedEndpoint[]>;
  getWslState: () => Promise<DesktopWslState>;
  setWslBackendEnabled: (enabled: boolean) => Promise<DesktopWslState>;
  setWslDistro: (distro: string | null) => Promise<DesktopWslState>;
  setWslOnly: (enabled: boolean) => Promise<DesktopWslState>;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  /**
   * Multi-select JSON file picker that opens in the VS Code extensions
   * directory when one exists. Optional: older desktop builds lack it, and
   * web callers fall back to a plain file input.
   */
  pickThemeFiles?: () => Promise<readonly PickedThemeFile[] | null>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  /**
   * Quit-confirmation hint pushes. Optional: older desktop builds never emit
   * them.
   */
  onQuitShortcut?: (listener: (event: QuitShortcutHintEvent) => void) => () => void;
  getWindowFullscreenState: () => boolean;
  onWindowFullscreenStateChange: (listener: (fullscreen: boolean) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  /**
   * Desktop-only preview surface. Present iff the renderer is hosted by the
   * Electron desktop build; web builds have `preview === undefined`.
   */
  preview?: DesktopPreviewBridge;
}

export interface DesktopPreviewBridge {
  createTab: (tabId: string, defaults?: DesktopPreviewTabDefaults) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  registerWebview: (tabId: string, webContentsId: number) => Promise<void>;
  navigate: (tabId: string, url: string) => Promise<void>;
  goBack: (tabId: string) => Promise<void>;
  goForward: (tabId: string) => Promise<void>;
  refresh: (tabId: string) => Promise<void>;
  zoomIn: (tabId: string) => Promise<void>;
  zoomOut: (tabId: string) => Promise<void>;
  resetZoom: (tabId: string) => Promise<void>;
  /** Reload bypassing the HTTP cache. */
  hardReload: (tabId: string) => Promise<void>;
  /**
   * Emulate `prefers-color-scheme` on the guest page ("system" clears the
   * override). Persists per tab and is re-applied across webview swaps.
   */
  setColorScheme: (tabId: string, colorScheme: DesktopPreviewColorScheme) => Promise<void>;
  /**
   * Silence the tab's audio output. Persists per tab and is re-applied across
   * webview swaps, but is dropped when the tab closes. Muting a silent tab is
   * allowed; it simply takes effect once the page plays something.
   */
  setAudioMuted: (tabId: string, audioMuted: boolean) => Promise<void>;
  /** Open the guest webview's DevTools (detached). */
  openDevTools: (tabId: string) => Promise<void>;
  /** Drop cookies + storage data for the preview partition (all tabs). */
  clearCookies: () => Promise<void>;
  /** Drop the HTTP cache for the preview partition (all tabs). */
  clearCache: () => Promise<void>;
  /**
   * One-shot config for mounting a preview `<webview>`. Replaces three
   * earlier round-trip calls (`getBrowserPartition`, `getWebviewPreferences`,
   * `getPickPreloadPath`) so adding a new field here only requires touching
   * the contract + main, not the renderer's mount logic.
   */
  getPreviewConfig: (environmentId: EnvironmentId) => Promise<DesktopPreviewWebviewConfig>;
  setAnnotationTheme: (theme: DesktopPreviewAnnotationTheme) => Promise<void>;
  /**
   * Activate the in-page element picker for the given tab. Resolves with
   * the picked annotation and its attach/send intent, or `null` when the
   * user cancels (Escape / nav). The promise rejects if the picker can't be
   * activated (no webview, etc.).
   */
  pickElement: (tabId: string) => Promise<PreviewAnnotationSubmissionResult | null>;
  /** Cancel an in-flight preview annotation session. */
  cancelPickElement: (tabId: string) => Promise<void>;
  captureScreenshot: (tabId: string) => Promise<DesktopPreviewScreenshotArtifact>;
  revealArtifact: (path: string) => Promise<void>;
  copyArtifactToClipboard: (path: string) => Promise<void>;
  pictureInPicture: {
    open: (tabId: string) => Promise<void>;
    close: (tabId: string) => Promise<void>;
  };
  recording: {
    startScreencast: (tabId: string) => Promise<void>;
    stopScreencast: (tabId: string) => Promise<void>;
    save: (
      tabId: string,
      mimeType: string,
      data: Uint8Array,
    ) => Promise<DesktopPreviewRecordingArtifact>;
    onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => () => void;
  };
  automation: {
    status: (tabId: string) => Promise<PreviewAutomationStatus>;
    snapshot: (tabId: string) => Promise<PreviewAutomationSnapshot>;
    click: (tabId: string, input: PreviewAutomationClickInput) => Promise<void>;
    type: (tabId: string, input: PreviewAutomationTypeInput) => Promise<void>;
    press: (tabId: string, input: PreviewAutomationPressInput) => Promise<void>;
    scroll: (tabId: string, input: PreviewAutomationScrollInput) => Promise<void>;
    evaluate: (tabId: string, input: PreviewAutomationEvaluateInput) => Promise<unknown>;
    waitFor: (tabId: string, input: PreviewAutomationWaitForInput) => Promise<void>;
  };
  onStateChange: (listener: (tabId: string, state: DesktopPreviewTabState) => void) => () => void;
  onPointerEvent: (listener: (event: DesktopPreviewPointerEvent) => void) => () => void;
}

export type ConfirmDialogVariant = "default" | "destructive";

export interface ConfirmDialogOptions {
  readonly variant?: ConfirmDialogVariant;
  /** Names the confirming action, such as "Delete group". Defaults to "Confirm". */
  readonly confirmLabel?: string;
}

/**
 * APIs bound to the local app shell, not to any particular backend environment.
 *
 * These capabilities describe the desktop/browser host that the user is
 * currently running: dialogs, external-link opening, context menus, and
 * app-level settings/config access. They must not be used as a proxy for
 * "whatever environment the user is targeting", because in a multi-environment
 * world the local shell and a selected backend environment are distinct
 * concepts.
 */
export interface LocalApi {
  dialogs: {
    pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
    confirm: (message: string, options?: ConfirmDialogOptions) => Promise<boolean>;
  };
  shell: {
    openExternal: (url: string) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
    close: () => Promise<void>;
  };
  persistence: {
    getClientSettings: () => Promise<ClientSettings | null>;
    setClientSettings: (settings: ClientSettings) => Promise<void>;
  };
}

export {
  type ContextMenuItem,
  type QuitShortcutHintEvent,
  type ContextMenuItemSchemaType,
  ContextMenuItemSchema,
  type DesktopUpdateStatus,
  type DesktopRuntimeArch,
  type DesktopTheme,
  type DesktopUpdateChannel,
  type DesktopAppStageLabel,
  DesktopUpdateStatusSchema,
  DesktopRuntimeArchSchema,
  DesktopThemeSchema,
  DesktopUpdateChannelSchema,
  DesktopAppStageLabelSchema,
  type DesktopAppBranding,
  DesktopAppBrandingSchema,
  type DesktopRuntimeInfo,
  DesktopRuntimeInfoSchema,
  type DesktopUpdateState,
  type DesktopUpdateReleaseNote,
  DesktopUpdateReleaseNoteSchema,
  DesktopUpdateStateSchema,
} from "./ipc/app.ts";

export {
  type DesktopUpdateActionResult,
  DesktopUpdateActionResultSchema,
  type DesktopUpdateCheckResult,
  DesktopUpdateCheckResultSchema,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopEnvironmentBootstrap,
  DesktopEnvironmentBootstrapSchema,
  DesktopSshEnvironmentTargetSchema,
  type DesktopSshEnvironmentTarget,
  type DesktopSshHostSource,
  DesktopSshHostSourceSchema,
  type DesktopDiscoveredSshHost,
  DesktopDiscoveredSshHostSchema,
  type DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentBootstrapSchema,
  type DesktopSshPasswordPromptRequest,
  DesktopSshPasswordPromptRequestSchema,
  DesktopSshPasswordPromptCancelledType,
  DesktopSshPasswordPromptCancelledResultSchema,
} from "./ipc/environment.ts";

export {
  DesktopSshEnvironmentEnsureOptionsSchema,
  DesktopSshEnvironmentEnsureInputSchema,
  DesktopSshEnvironmentEnsureResultSchema,
  DesktopSshHttpBaseUrlInputSchema,
  DesktopSshBearerRequestInputSchema,
  DesktopSshBearerBootstrapInputSchema,
  DesktopSshPasswordPromptResolutionInputSchema,
  PersistedSavedEnvironmentRecordSchema,
  type PersistedSavedEnvironmentRecord,
  type DesktopServerExposureMode,
  DesktopServerExposureModeSchema,
  type DesktopServerExposureState,
  DesktopServerExposureStateSchema,
  type PickFolderOptions,
  PickFolderOptionsSchema,
  type PickedThemeFile,
  PickedThemeFileSchema,
  type DesktopWslDistro,
  DesktopWslDistroSchema,
  type DesktopWslState,
  DesktopWslStateSchema,
  type DesktopPreviewNavStatus,
  type DesktopPreviewColorScheme,
  DesktopPreviewColorSchemeSchema,
  FAVICON_DATA_URL_MAX_LENGTH,
  FAVICON_CAPTURED_AT_MAX,
  type DesktopPreviewFavicon,
  DesktopPreviewFaviconSchema,
  type DesktopPreviewTabState,
  DesktopPreviewTabIdSchema,
  DesktopPreviewNavStatusSchema,
  DesktopPreviewTabStateSchema,
  type DesktopPreviewPointerEvent,
  DesktopPreviewPointerEventSchema,
  type DesktopPreviewWebviewConfig,
  DesktopPreviewWebviewConfigSchema,
  type DesktopPreviewAnnotationTheme,
  DesktopPreviewAnnotationThemeSchema,
  type DesktopPreviewRecordingFrame,
  DesktopPreviewRecordingFrameSchema,
  type DesktopPreviewRecordingArtifact,
  DesktopPreviewRecordingArtifactSchema,
  type DesktopPreviewScreenshotArtifact,
  DesktopPreviewScreenshotArtifactSchema,
} from "./ipc/preview.ts";

export {
  type PickedElementStackFrame,
  PickedElementStackFrameSchema,
  type PickedElementPayload,
  PickedElementPayloadSchema,
  type PreviewAnnotationRect,
  PreviewAnnotationRectSchema,
  type PreviewAnnotationPoint,
  PreviewAnnotationPointSchema,
  type PreviewAnnotationElementTarget,
  PreviewAnnotationElementTargetSchema,
  type PreviewAnnotationRegionTarget,
  PreviewAnnotationRegionTargetSchema,
  type PreviewAnnotationStrokeTarget,
  PreviewAnnotationStrokeTargetSchema,
  type PreviewAnnotationStyleChange,
  PreviewAnnotationStyleChangeSchema,
  type PreviewAnnotationScreenshot,
  PreviewAnnotationScreenshotSchema,
  type PreviewAnnotationPayload,
  PreviewAnnotationPayloadSchema,
  type PreviewAnnotationSubmission,
  PreviewAnnotationSubmissionSchema,
  type PreviewAnnotationSubmissionResult,
  PreviewAnnotationSubmissionResultSchema,
} from "./ipc/annotations.ts";

export {
  DesktopPreviewTabInputSchema,
  DesktopPreviewCreateTabInputSchema,
  type DesktopPreviewTabDefaults,
  DesktopPreviewRegisterWebviewInputSchema,
  DesktopPreviewNavigateInputSchema,
  DesktopPreviewConfigInputSchema,
  DesktopPreviewSetColorSchemeInputSchema,
  DesktopPreviewSetAudioMutedInputSchema,
  DesktopPreviewAnnotationThemeInputSchema,
  DesktopPreviewArtifactInputSchema,
  DesktopPreviewRecordingSaveInputSchema,
  DesktopPreviewAutomationClickInputSchema,
  DesktopPreviewAutomationTypeInputSchema,
  DesktopPreviewAutomationPressInputSchema,
  DesktopPreviewAutomationScrollInputSchema,
  DesktopPreviewAutomationEvaluateInputSchema,
  DesktopPreviewAutomationWaitForInputSchema,
} from "./ipc/previewAutomation.ts";
