import {
  DesktopServerExposureModeSchema,
  DesktopUpdateChannelSchema,
  type DesktopServerExposureMode,
  type DesktopUpdateChannel,
} from "@akeru/contracts";
import { fromLenientJson } from "@akeru/shared/schemaJson";

import * as Option from "effect/Option";

import * as Schema from "effect/Schema";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import { resolveDefaultDesktopUpdateChannel } from "../updates/updateChannels.ts";
import { isValidDistroName } from "../wsl/wslPathParsing.ts";

export interface DesktopSettings {
  readonly linuxPasswordStore: LinuxPasswordStorePreference;
  readonly mainWindowBounds: DesktopWindowBounds | null;
  readonly mainWindowMaximized: boolean;
  readonly serverExposureMode: DesktopServerExposureMode;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
  readonly updateChannel: DesktopUpdateChannel;
  readonly updateChannelConfiguredByUser: boolean;
  // Was a "local" | "wsl" swap mode in an earlier iteration of the WSL
  // integration. We now run Windows and WSL backends side by side, so the
  // setting is just whether the WSL backend should be running alongside the
  // primary. Persisted documents that still carry the legacy `wslMode: "wsl"`
  // value are migrated to `wslBackendEnabled: true` on load.
  readonly wslBackendEnabled: boolean;
  readonly wslDistro: string | null;
  // When true (and wslBackendEnabled is also true) the desktop runs only
  // the WSL backend as the primary, and the Windows-side Node backend is
  // not started. Designed for users who develop entirely inside WSL and
  // don't want a second backend process running. Defaults to false so
  // existing setups stay on the parallel-backends behavior. Changing
  // this requires a desktop restart because the pool's primary spec is
  // chosen once at layer init.
  readonly wslOnly: boolean;
}

export interface DesktopSettingsChange {
  readonly settings: DesktopSettings;
  readonly changed: boolean;
}

export const DEFAULT_TAILSCALE_SERVE_PORT = 443;

export const MIN_MAIN_WINDOW_SIZE = {
  width: 840,
  height: 620,
} as const;

export const DesktopWindowBoundsSchema = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_MAIN_WINDOW_SIZE.width)),
  height: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_MAIN_WINDOW_SIZE.height)),
});

export type DesktopWindowBounds = typeof DesktopWindowBoundsSchema.Type;

export const DEFAULT_MAIN_WINDOW_SIZE = {
  width: 1100,
  height: 780,
} as const;

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  linuxPasswordStore: DEFAULT_LINUX_PASSWORD_STORE,
  mainWindowBounds: null,
  mainWindowMaximized: false,
  serverExposureMode: "local-only",
  tailscaleServeEnabled: false,
  tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  updateChannel: "latest",
  updateChannelConfiguredByUser: false,
  wslBackendEnabled: false,
  wslDistro: null,
  wslOnly: false,
};

export const DesktopWindowBoundsDocument = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});

export const DesktopSettingsDocument = Schema.Struct({
  linuxPasswordStore: Schema.optionalKey(Schema.Unknown),
  mainWindowBounds: Schema.optionalKey(Schema.NullOr(DesktopWindowBoundsDocument)),
  mainWindowMaximized: Schema.optionalKey(Schema.Boolean),
  serverExposureMode: Schema.optionalKey(DesktopServerExposureModeSchema),
  tailscaleServeEnabled: Schema.optionalKey(Schema.Boolean),
  tailscaleServePort: Schema.optionalKey(Schema.Number),
  updateChannel: Schema.optionalKey(DesktopUpdateChannelSchema),
  updateChannelConfiguredByUser: Schema.optionalKey(Schema.Boolean),
  // Newer form of the WSL toggle. `wslMode` is still accepted on load so
  // existing on-disk settings keep working; on the next persist we write the
  // new boolean and the legacy key drops out.
  wslBackendEnabled: Schema.optionalKey(Schema.Boolean),
  wslMode: Schema.optionalKey(Schema.Literals(["local", "wsl"])),
  wslDistro: Schema.optionalKey(Schema.NullOr(Schema.String)),
  wslOnly: Schema.optionalKey(Schema.Boolean),
});

export type DesktopSettingsDocument = typeof DesktopSettingsDocument.Type;

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const DesktopSettingsJson = fromLenientJson(DesktopSettingsDocument);

export const decodeDesktopSettingsJson = Schema.decodeEffect(DesktopSettingsJson);

export const encodeDesktopSettingsJson = Schema.encodeEffect(DesktopSettingsJson);

export const decodeDesktopWindowBounds = Schema.decodeUnknownOption(DesktopWindowBoundsSchema);

export const desktopWindowBoundsEquivalence = Schema.toEquivalence(DesktopWindowBoundsSchema);

export const settingsChange = (
  settings: DesktopSettings,
  changed: boolean,
): DesktopSettingsChange => ({
  settings,
  changed,
});

export function resolveDefaultDesktopSettings(appVersion: string): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    updateChannel: resolveDefaultDesktopUpdateChannel(appVersion),
  };
}

export function normalizeTailscaleServePort(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : DEFAULT_TAILSCALE_SERVE_PORT;
}

export function normalizeWslDistro(value: unknown): string | null {
  return typeof value === "string" && isValidDistroName(value) ? value : null;
}

export function normalizeMainWindowBounds(value: unknown): DesktopWindowBounds | null {
  return Option.getOrNull(decodeDesktopWindowBounds(value));
}

export function normalizeDesktopSettingsDocument(
  parsed: DesktopSettingsDocument,
  appVersion: string,
): DesktopSettings {
  const defaultSettings = resolveDefaultDesktopSettings(appVersion);
  const mainWindowBounds = normalizeMainWindowBounds(parsed.mainWindowBounds);
  const parsedUpdateChannel = Option.fromNullishOr(parsed.updateChannel);
  const updateChannelConfiguredByUser = parsed.updateChannelConfiguredByUser === true;

  // Newer form wins when both are present; otherwise fall back to the legacy
  // `wslMode === "wsl"` signal so users coming off the swap-mode build keep
  // their WSL backend enabled.
  const wslBackendEnabled =
    parsed.wslBackendEnabled === true ||
    (parsed.wslBackendEnabled === undefined && parsed.wslMode === "wsl");

  return {
    linuxPasswordStore: normalizeLinuxPasswordStorePreference(parsed.linuxPasswordStore),
    mainWindowBounds,
    mainWindowMaximized: mainWindowBounds !== null && parsed.mainWindowMaximized === true,
    serverExposureMode:
      parsed.serverExposureMode === "network-accessible" ? "network-accessible" : "local-only",
    tailscaleServeEnabled: parsed.tailscaleServeEnabled === true,
    tailscaleServePort: normalizeTailscaleServePort(parsed.tailscaleServePort),
    updateChannel: updateChannelConfiguredByUser
      ? Option.getOrElse(parsedUpdateChannel, () => defaultSettings.updateChannel)
      : defaultSettings.updateChannel,
    updateChannelConfiguredByUser,
    wslBackendEnabled,
    wslDistro: normalizeWslDistro(parsed.wslDistro),
    wslOnly: parsed.wslOnly === true,
  };
}

export function toDesktopSettingsDocument(
  settings: DesktopSettings,
  defaults: DesktopSettings,
): DesktopSettingsDocument {
  const document: Mutable<DesktopSettingsDocument> = {};

  if (settings.linuxPasswordStore !== defaults.linuxPasswordStore) {
    document.linuxPasswordStore = settings.linuxPasswordStore;
  }

  if (settings.mainWindowBounds !== null) {
    document.mainWindowBounds = settings.mainWindowBounds;
  }

  if (settings.mainWindowMaximized) {
    document.mainWindowMaximized = true;
  }

  if (settings.serverExposureMode !== defaults.serverExposureMode) {
    document.serverExposureMode = settings.serverExposureMode;
  }

  if (settings.tailscaleServeEnabled !== defaults.tailscaleServeEnabled) {
    document.tailscaleServeEnabled = settings.tailscaleServeEnabled;
  }

  if (settings.tailscaleServePort !== defaults.tailscaleServePort) {
    document.tailscaleServePort = settings.tailscaleServePort;
  }

  if (settings.updateChannel !== defaults.updateChannel) {
    document.updateChannel = settings.updateChannel;
  }

  if (settings.updateChannelConfiguredByUser !== defaults.updateChannelConfiguredByUser) {
    document.updateChannelConfiguredByUser = settings.updateChannelConfiguredByUser;
  }

  if (settings.wslBackendEnabled !== defaults.wslBackendEnabled) {
    document.wslBackendEnabled = settings.wslBackendEnabled;
  }

  if (settings.wslDistro !== defaults.wslDistro) {
    document.wslDistro = settings.wslDistro;
  }

  if (settings.wslOnly !== defaults.wslOnly) {
    document.wslOnly = settings.wslOnly;
  }

  return document;
}

export function setServerExposureMode(
  settings: DesktopSettings,
  requestedMode: DesktopServerExposureMode,
): DesktopSettings {
  return settings.serverExposureMode === requestedMode
    ? settings
    : {
        ...settings,
        serverExposureMode: requestedMode,
      };
}

export function setMainWindowBounds(
  settings: DesktopSettings,
  bounds: DesktopWindowBounds,
  isMaximized: boolean,
): DesktopSettings {
  return settings.mainWindowBounds !== null &&
    desktopWindowBoundsEquivalence(settings.mainWindowBounds, bounds) &&
    settings.mainWindowMaximized === isMaximized
    ? settings
    : {
        ...settings,
        mainWindowBounds: bounds,
        mainWindowMaximized: isMaximized,
      };
}

export function setTailscaleServe(
  settings: DesktopSettings,
  input: { readonly enabled: boolean; readonly port: Option.Option<number> },
): DesktopSettings {
  const port = Option.match(input.port, {
    onNone: () => settings.tailscaleServePort,
    onSome: normalizeTailscaleServePort,
  });

  return settings.tailscaleServeEnabled === input.enabled && settings.tailscaleServePort === port
    ? settings
    : {
        ...settings,
        tailscaleServeEnabled: input.enabled,
        tailscaleServePort: port,
      };
}

export function setUpdateChannel(
  settings: DesktopSettings,
  requestedChannel: DesktopUpdateChannel,
): DesktopSettings {
  return settings.updateChannel === requestedChannel
    ? settings
    : {
        ...settings,
        updateChannel: requestedChannel,
        updateChannelConfiguredByUser: true,
      };
}

export function setWslBackendEnabled(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.wslBackendEnabled === enabled
    ? settings
    : {
        ...settings,
        wslBackendEnabled: enabled,
      };
}

export function setWslDistro(settings: DesktopSettings, distro: string | null): DesktopSettings {
  const normalized = normalizeWslDistro(distro);

  return settings.wslDistro === normalized
    ? settings
    : {
        ...settings,
        wslDistro: normalized,
      };
}

export function setWslOnly(settings: DesktopSettings, enabled: boolean): DesktopSettings {
  return settings.wslOnly === enabled
    ? settings
    : {
        ...settings,
        wslOnly: enabled,
      };
}

export function applyWslWindowsFallback(settings: DesktopSettings): DesktopSettings {
  return setWslOnly(setWslBackendEnabled(settings, false), false);
}
