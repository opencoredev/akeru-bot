import * as Predicate from "effect/Predicate";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "@akeru/contracts";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@akeru/shared/schemaJson";

export const ServerSettingsJson = fromLenientJson(ServerSettings);

export const decodeServerSettingsJsonExit = Schema.decodeUnknownExit(ServerSettingsJson);

export const PersistedOptionalProviderSettings = Schema.Struct({
  providers: Schema.optionalKey(
    Schema.Struct({
      grok: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
      kimi: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
      opencode: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
      opencodeGo: Schema.optionalKey(
        Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }),
      ),
    }),
  ),
});

export const decodePersistedOptionalProviderSettingsJsonExit = Schema.decodeUnknownExit(
  fromLenientJson(PersistedOptionalProviderSettings),
);

// Values under these keys are compared as a whole — never stripped field-by-field.
export const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "sourceControlWriterModelSelection",
  "textGenerationModelSelection",
]);

// Preserve both enabled states because provider history cannot recover a new opt-in.
export const PERSISTED_SERVER_SETTINGS_DEFAULTS = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, enabled: undefined },
    opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: undefined },
  },
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Provider option values are opaque settings; this recursive walker compares and preserves them without decoding their contents.
export function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (Predicate.isObject(current) && Predicate.isObject(defaults)) {
    const currentRecord = current;
    const defaultsRecord = defaults;
    const next = { ...currentRecord };

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (Equal.equals(currentRecord[key], defaultsRecord[key])) delete next[key];
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);

        if (stripped !== undefined) {
          next[key] = stripped;
        } else {
          delete next[key];
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}
