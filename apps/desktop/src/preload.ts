import {
  DesktopSshPasswordPromptRequestSchema,
  DesktopUpdateStateSchema,
  DesktopPreviewRecordingFrameSchema,
  DesktopPreviewPointerEventSchema,
  DesktopAppBrandingSchema,
  DesktopEnvironmentBootstrapSchema,
  DesktopSshEnvironmentEnsureResultSchema,
  DesktopPreviewTabStateSchema,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { DesktopBridge } from "@akeru/contracts";
import { contextBridge, ipcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";

const QuitShortcutHint = Schema.Union([
  Schema.Struct({ state: Schema.Literal("up") }),
  Schema.Struct({ state: Schema.Literal("down"), mode: Schema.Literals(["hold", "double-click"]) }),
]);

const decodeSshPasswordPrompt = Schema.decodeUnknownOption(DesktopSshPasswordPromptRequestSchema);

const decodeMenuAction = Schema.decodeUnknownOption(Schema.String);

const decodeQuitShortcut = Schema.decodeUnknownOption(QuitShortcutHint);

const decodeWindowFullscreenStateChange = Schema.decodeUnknownOption(Schema.Boolean);

const decodeUpdateState = Schema.decodeUnknownOption(DesktopUpdateStateSchema);

const decodeFrame = Schema.decodeUnknownOption(DesktopPreviewRecordingFrameSchema);

const decodePointerEvent = Schema.decodeUnknownOption(DesktopPreviewPointerEventSchema);

const decodeBranding = Schema.decodeUnknownOption(DesktopAppBrandingSchema);

const decodeBootstraps = Schema.decodeUnknownOption(
  Schema.Array(DesktopEnvironmentBootstrapSchema),
);

const decodePreviewState = Schema.decodeUnknownOption(DesktopPreviewTabStateSchema);

const decodeEnsureSsh = Schema.decodeUnknownSync(DesktopSshEnvironmentEnsureResultSchema);

function subscribeDecoded<A>(
  channel: string,
  decode: ReturnType<typeof Schema.decodeUnknownOption<Schema.Codec<A>>>,
  listener: (value: A) => void,
) {
  const wrappedListener: Parameters<typeof ipcRenderer.on>[1] = (_event, raw) => {
    const parsed = decode(raw);

    if (Option.isSome(parsed)) listener(parsed.value);
  };

  ipcRenderer.on(channel, wrappedListener);

  return () => ipcRenderer.removeListener(channel, wrappedListener);
}

function unwrapEnsureSshEnvironmentResult(result: ReturnType<typeof decodeEnsureSsh>) {
  if ("type" in result && result.type === IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT)
    throw new Error(result.message);

  if ("target" in result) return result;
  throw new Error("SSH authentication cancelled.");
}

contextBridge.exposeInMainWorld("desktopBridge", {
  getAppBranding: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_APP_BRANDING_CHANNEL);

    return Option.getOrNull(decodeBranding(result));
  },
  getSystemLocale: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_SYSTEM_LOCALE_CHANNEL);

    return Predicate.isString(result) ? result : null;
  },
  getLocalEnvironmentBootstraps: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL);

    return Option.getOrElse(decodeBootstraps(result), () => []);
  },
  getLocalEnvironmentBearerToken: () =>
    ipcRenderer.invoke(IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL),
  getClientSettings: () => ipcRenderer.invoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL),
  setClientSettings: (settings) =>
    ipcRenderer.invoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL, settings),
  getConnectionCatalog: () => ipcRenderer.invoke(IpcChannels.GET_CONNECTION_CATALOG_CHANNEL),
  setConnectionCatalog: (catalog) =>
    ipcRenderer.invoke(IpcChannels.SET_CONNECTION_CATALOG_CHANNEL, catalog),
  clearConnectionCatalog: () => ipcRenderer.invoke(IpcChannels.CLEAR_CONNECTION_CATALOG_CHANNEL),
  discoverSshHosts: () => ipcRenderer.invoke(IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL),
  ensureSshEnvironment: async (target, options) =>
    unwrapEnsureSshEnvironmentResult(
      decodeEnsureSsh(
        await ipcRenderer.invoke(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL, {
          target,
          ...(options === undefined ? {} : { options }),
        }),
      ),
    ),
  disconnectSshEnvironment: (target) =>
    ipcRenderer.invoke(IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL, target),
  fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, { httpBaseUrl }),
  bootstrapSshBearerSession: (httpBaseUrl, credential) =>
    ipcRenderer.invoke(IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL, {
      httpBaseUrl,
      credential,
    }),
  fetchSshSessionState: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL, { httpBaseUrl, bearerToken }),
  issueSshWebSocketTicket: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL, { httpBaseUrl, bearerToken }),
  onSshPasswordPrompt: (listener) =>
    subscribeDecoded(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, decodeSshPasswordPrompt, listener),
  resolveSshPasswordPrompt: (requestId, password) =>
    ipcRenderer.invoke(IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL, { requestId, password }),
  getServerExposureState: () => ipcRenderer.invoke(IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL),
  setServerExposureMode: (mode) =>
    ipcRenderer.invoke(IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL, mode),
  setTailscaleServeEnabled: (input) =>
    ipcRenderer.invoke(IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL, input),
  getAdvertisedEndpoints: () => ipcRenderer.invoke(IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL),
  getWslState: () => ipcRenderer.invoke(IpcChannels.GET_WSL_STATE_CHANNEL),
  setWslBackendEnabled: (enabled) =>
    ipcRenderer.invoke(IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL, enabled),
  setWslDistro: (distro) => ipcRenderer.invoke(IpcChannels.SET_WSL_DISTRO_CHANNEL, distro),
  setWslOnly: (enabled) => ipcRenderer.invoke(IpcChannels.SET_WSL_ONLY_CHANNEL, enabled),
  pickFolder: (options) => ipcRenderer.invoke(IpcChannels.PICK_FOLDER_CHANNEL, options),
  pickThemeFiles: () => ipcRenderer.invoke(IpcChannels.PICK_THEME_FILES_CHANNEL, undefined),
  setTheme: (theme) => ipcRenderer.invoke(IpcChannels.SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) =>
    ipcRenderer.invoke(IpcChannels.CONTEXT_MENU_CHANNEL, {
      items,
      ...(position === undefined ? {} : { position }),
    }),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) =>
    subscribeDecoded(IpcChannels.MENU_ACTION_CHANNEL, decodeMenuAction, listener),
  onQuitShortcut: (listener) =>
    subscribeDecoded(IpcChannels.QUIT_SHORTCUT_CHANNEL, decodeQuitShortcut, listener),
  getWindowFullscreenState: () =>
    ipcRenderer.sendSync(IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL) === true,
  onWindowFullscreenStateChange: (listener) =>
    subscribeDecoded(
      IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL,
      decodeWindowFullscreenStateChange,
      listener,
    ),
  getUpdateState: () => ipcRenderer.invoke(IpcChannels.UPDATE_GET_STATE_CHANNEL),
  setUpdateChannel: (channel) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_SET_CHANNEL_CHANNEL, channel),
  checkForUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) =>
    subscribeDecoded(IpcChannels.UPDATE_STATE_CHANNEL, decodeUpdateState, listener),
  preview: {
    createTab: (tabId, defaults) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CREATE_TAB_CHANNEL, {
        tabId,
        zoomFactor: defaults?.zoomFactor,
        colorScheme: defaults?.colorScheme,
      }),
    closeTab: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL, { tabId }),
    registerWebview: (tabId, webContentsId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, { tabId, webContentsId }),
    navigate: (tabId, url) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_NAVIGATE_CHANNEL, { tabId, url }),
    goBack: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_BACK_CHANNEL, { tabId }),
    goForward: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_FORWARD_CHANNEL, { tabId }),
    refresh: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_REFRESH_CHANNEL, { tabId }),
    zoomIn: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_IN_CHANNEL, { tabId }),
    zoomOut: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL, { tabId }),
    resetZoom: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL, { tabId }),
    hardReload: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL, { tabId }),
    setColorScheme: (tabId, colorScheme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL, { tabId, colorScheme }),
    setAudioMuted: (tabId, audioMuted) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL, { tabId, audioMuted }),
    openDevTools: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, { tabId }),
    clearCookies: () => ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL),
    clearCache: () => ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL),
    getPreviewConfig: (environmentId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, { environmentId }),
    setAnnotationTheme: (theme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL, { theme }),
    pickElement: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL, { tabId }),
    cancelPickElement: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, { tabId }),
    captureScreenshot: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, { tabId }),
    revealArtifact: (path) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL, { path }),
    copyArtifactToClipboard: (path) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL, { path }),
    pictureInPicture: {
      open: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL, { tabId }),
      close: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL, { tabId }),
    },
    recording: {
      startScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_START_CHANNEL, { tabId }),
      stopScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL, { tabId }),
      save: (tabId, mimeType, data) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL, {
          tabId,
          mimeType,
          data,
        }),
      onFrame: (listener) =>
        subscribeDecoded(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, decodeFrame, listener),
    },
    automation: {
      status: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_STATUS_CHANNEL, { tabId }),
      snapshot: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_SNAPSHOT_CHANNEL, { tabId }),
      click: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_CLICK_CHANNEL, { tabId, input }),
      type: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_TYPE_CHANNEL, { tabId, input }),
      press: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_PRESS_CHANNEL, { tabId, input }),
      scroll: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_SCROLL_CHANNEL, { tabId, input }),
      evaluate: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_EVALUATE_CHANNEL, { tabId, input }),
      waitFor: (tabId, input) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_AUTOMATION_WAIT_FOR_CHANNEL, { tabId, input }),
    },
    onStateChange: (listener) => {
      const wrappedListener: Parameters<typeof ipcRenderer.on>[1] = (_event, tabId, state) => {
        if (!Predicate.isString(tabId)) return;
        const parsed = decodePreviewState(state);

        if (Option.isSome(parsed)) listener(tabId, parsed.value);
      };

      ipcRenderer.on(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);

      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
    },
    onPointerEvent: (listener) =>
      subscribeDecoded(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, decodePointerEvent, listener),
  },
} satisfies DesktopBridge);
