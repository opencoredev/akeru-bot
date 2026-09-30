import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Option from "effect/Option";

const trimNonEmptyOption = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
};

const trimmedString = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.flatMap(trimNonEmptyOption)));

/**
 * Variables shared with the server read `AKERU_<suffix>` first and fall back
 * to the legacy `T3CODE_<suffix>` name, matching the server's own aliases.
 */
const aliasedTrimmedString = (suffix: string) =>
  Config.all([trimmedString(`AKERU_${suffix}`), trimmedString(`T3CODE_${suffix}`)]).pipe(
    Config.map(([primary, legacy]) => Option.orElse(primary, () => legacy)),
  );

const aliasedOption = <A>(read: (name: string) => Config.Config<A>, suffix: string) =>
  Config.all([
    Config.option(read(`AKERU_${suffix}`)),
    Config.option(read(`T3CODE_${suffix}`)),
  ]).pipe(Config.map(([primary, legacy]) => Option.orElse(primary, () => legacy)));

const optionalBoolean = (name: string) =>
  Config.boolean(name).pipe(Config.option, Config.map(Option.getOrElse(() => false)));

const commaSeparatedStrings = (name: string) =>
  trimmedString(name).pipe(
    Config.map(
      Option.match({
        onNone: () => [],
        onSome: (value) =>
          value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0),
      }),
    ),
  );

const compactEnv = (env: Readonly<Record<string, string | undefined>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export const DesktopConfig = Config.all({
  appDataDirectory: trimmedString("APPDATA"),
  xdgConfigHome: trimmedString("XDG_CONFIG_HOME"),
  xdgDataHome: trimmedString("XDG_DATA_HOME"),
  t3Home: aliasedTrimmedString("HOME"),
  devServerUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option),
  appUserModelIdOverride: trimmedString("T3CODE_DESKTOP_APP_USER_MODEL_ID"),
  devRemoteT3ServerEntryPath: trimmedString("T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH"),
  configuredBackendPort: aliasedOption(Config.port, "PORT"),
  commitHashOverride: trimmedString("T3CODE_COMMIT_HASH"),
  desktopLanHostOverride: trimmedString("T3CODE_DESKTOP_LAN_HOST"),
  desktopHttpsEndpointUrls: commaSeparatedStrings("T3CODE_DESKTOP_HTTPS_ENDPOINTS"),
  otlpTracesUrl: aliasedTrimmedString("OTLP_TRACES_URL"),
  otlpExportIntervalMs: aliasedOption(Config.int, "OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.map(Option.getOrElse(() => 10_000)),
  ),
  appImagePath: trimmedString("APPIMAGE"),
  disableAutoUpdate: optionalBoolean("T3CODE_DISABLE_AUTO_UPDATE"),
  mockUpdates: optionalBoolean("T3CODE_DESKTOP_MOCK_UPDATES"),
  mockUpdateServerPort: Config.port("T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT").pipe(
    Config.withDefault(3000),
  ),
});

export const layerTest = (env: Readonly<Record<string, string | undefined>>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: compactEnv(env) }));
