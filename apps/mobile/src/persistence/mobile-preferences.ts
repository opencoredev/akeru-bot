import { Predicate } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { SidebarProjectGroupingMode } from "@akeru/contracts";
import {
  normalizeMobileThemeId,
  type MobileThemeId,
  type MobileThemeMode,
} from "../lib/mobileTheme";
import * as MobileDatabase from "./mobile-database";
import * as MobileSecureStorage from "./mobile-secure-storage";
import { MobileStorageDecodeError, MobileStorageEncodeError } from "./mobile-storage";

type MutablePreferences = { -readonly [Key in keyof Preferences]: Preferences[Key] };

const PREFERENCES_KEY = "akeru.preferences";

const PREFERENCES_FALLBACK_KEY = "akeru.preferences.fallback";

// Keys written before the rebrand; reads fall back once and the next write
// lands on the Akeru keys, draining the old entries.
const LEGACY_PREFERENCES_KEY = "t3code.preferences";

const LEGACY_PREFERENCES_FALLBACK_KEY = "t3code.preferences.fallback";

export interface Preferences {
  readonly language?: string;
  readonly reviewedPrivacyPolicyVersion?: string;
  readonly reviewedTermsVersion?: string;
  readonly liveActivitiesEnabled?: boolean;
  readonly themeId?: MobileThemeId;
  readonly lightThemeId?: MobileThemeId;
  readonly darkThemeId?: MobileThemeId;
  readonly themeMode?: MobileThemeMode;
  readonly baseFontSize?: number;
  readonly markdownFontSize?: number;
  /** @deprecated Kept temporarily so older OTA bundles retain the selected mode. */
  readonly projectGroupingEnabled?: boolean;
  readonly projectGroupingMode?: SidebarProjectGroupingMode;
  // Retired keys (legacyThreadListEnabled, planModeEnabled, terminalFontSize,
  // codeFontSize, codeWordBreak, collapsedProjectGroups) are dropped by
  // sanitizing on the next load.
  /** Undefined preserves the default expanded Settled shelf. */
  readonly threadListV2SettledShelfExpanded?: boolean;
  /** Undefined preserves the default collapsed Snoozed shelf. */
  readonly threadListV2SnoozedShelfExpanded?: boolean;
}

export class MobilePreferencesLoadError extends Schema.TaggedErrorClass<MobilePreferencesLoadError>()(
  "MobilePreferencesLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load mobile preferences.";
  }
}

export class MobilePreferencesSaveError extends Schema.TaggedErrorClass<MobilePreferencesSaveError>()(
  "MobilePreferencesSaveError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to save mobile preferences.";
  }
}

interface PreferencesFallback {
  readonly payload: string;
  readonly updatedAt: number;
  readonly preferences: typeof StoredPreferences.Type;
}

export class MobilePreferencesStore extends Context.Service<
  MobilePreferencesStore,
  {
    readonly load: Effect.Effect<Preferences, MobilePreferencesLoadError>;
    readonly savePatch: (
      patch: Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
    readonly update: (
      transform: (current: Preferences) => Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
  }
>()("@akeru/mobile/persistence/MobilePreferencesStore") {}

const StoredPreferences = Schema.Struct({
  language: Schema.optional(Schema.Unknown),
  reviewedPrivacyPolicyVersion: Schema.optional(Schema.Unknown),
  reviewedTermsVersion: Schema.optional(Schema.Unknown),
  liveActivitiesEnabled: Schema.optional(Schema.Unknown),
  themeId: Schema.optional(Schema.Unknown),
  lightThemeId: Schema.optional(Schema.Unknown),
  darkThemeId: Schema.optional(Schema.Unknown),
  themeMode: Schema.optional(Schema.Unknown),
  baseFontSize: Schema.optional(Schema.Unknown),
  markdownFontSize: Schema.optional(Schema.Unknown),
  projectGroupingEnabled: Schema.optional(Schema.Unknown),
  projectGroupingMode: Schema.optional(Schema.Unknown),
  threadListV2SettledShelfExpanded: Schema.optional(Schema.Unknown),
  threadListV2SnoozedShelfExpanded: Schema.optional(Schema.Unknown),
});

const decodeStoredPreferences = Schema.decodeUnknownSync(StoredPreferences);

function sanitizePreferences(parsed: typeof StoredPreferences.Type): Preferences {
  const preferences: MutablePreferences = {};

  if (Predicate.isString(parsed.language)) preferences.language = parsed.language;

  if (Predicate.isString(parsed.reviewedPrivacyPolicyVersion)) {
    preferences.reviewedPrivacyPolicyVersion = parsed.reviewedPrivacyPolicyVersion;
  }

  if (Predicate.isString(parsed.reviewedTermsVersion)) {
    preferences.reviewedTermsVersion = parsed.reviewedTermsVersion;
  }

  if (Predicate.isBoolean(parsed.liveActivitiesEnabled)) {
    preferences.liveActivitiesEnabled = parsed.liveActivitiesEnabled;
  }

  // Legacy ids (`t3-code`, `t3-chat`) canonicalize through the alias table so a
  // persisted selection survives the rebrand instead of being dropped.
  if (Predicate.isString(parsed.themeId)) {
    preferences.themeId = normalizeMobileThemeId(parsed.themeId);
  }

  if (Predicate.isString(parsed.lightThemeId)) {
    preferences.lightThemeId = normalizeMobileThemeId(parsed.lightThemeId);
  }

  if (Predicate.isString(parsed.darkThemeId)) {
    preferences.darkThemeId = normalizeMobileThemeId(parsed.darkThemeId);
  }

  if (
    parsed.themeMode === "system" ||
    parsed.themeMode === "light" ||
    parsed.themeMode === "dark"
  ) {
    preferences.themeMode = parsed.themeMode;
  }

  if (Predicate.isNumber(parsed.baseFontSize)) preferences.baseFontSize = parsed.baseFontSize;

  if (Predicate.isNumber(parsed.markdownFontSize)) {
    preferences.markdownFontSize = parsed.markdownFontSize;
  }

  if (Predicate.isBoolean(parsed.projectGroupingEnabled)) {
    preferences.projectGroupingEnabled = parsed.projectGroupingEnabled;
  }

  if (
    parsed.projectGroupingMode === "repository" ||
    parsed.projectGroupingMode === "repository_path" ||
    parsed.projectGroupingMode === "separate"
  ) {
    preferences.projectGroupingMode = parsed.projectGroupingMode;
  }

  if (Predicate.isBoolean(parsed.threadListV2SettledShelfExpanded)) {
    preferences.threadListV2SettledShelfExpanded = parsed.threadListV2SettledShelfExpanded;
  }

  if (Predicate.isBoolean(parsed.threadListV2SnoozedShelfExpanded)) {
    preferences.threadListV2SnoozedShelfExpanded = parsed.threadListV2SnoozedShelfExpanded;
  }

  return preferences;
}

export const make = Effect.fn("MobilePreferencesStore.make")(function* () {
  const database = yield* MobileDatabase.MobileDatabase;
  const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;
  const lock = yield* Semaphore.make(1);
  const lastUpdatedAt = yield* Ref.make(0);

  const parsePayload = (raw: string | null) => {
    if (raw === null || !raw.trim()) return null;
    let parsed: typeof StoredPreferences.Type;

    try {
      parsed = decodeStoredPreferences(JSON.parse(raw));
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_KEY, cause }),
      );

      return null;
    }

    return parsed;
  };

  const parseFallback = (raw: string | null): PreferencesFallback | null => {
    if (raw === null || !raw.trim()) return null;
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_FALLBACK_KEY, cause }),
      );

      return null;
    }

    if (
      !Predicate.isObjectOrArray(parsed) ||
      parsed === null ||
      !("payload" in parsed) ||
      !Predicate.isString(parsed.payload) ||
      !("updatedAt" in parsed) ||
      !Predicate.isNumber(parsed.updatedAt)
    ) {
      return null;
    }

    const preferences = parsePayload(parsed.payload);

    return preferences === null
      ? null
      : { payload: parsed.payload, updatedAt: parsed.updatedAt, preferences };
  };

  const encode = Effect.fn("MobilePreferencesStore.encode")(function* (
    key: string,
    value: Preferences | { readonly payload: string; readonly updatedAt: number },
  ) {
    return yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new MobileStorageEncodeError({ key, cause }),
    });
  });

  const nextUpdatedAt = Ref.modify(lastUpdatedAt, (last) => {
    const next = Math.max(Date.now(), last + 1);

    return [next, next] as const;
  });

  const clearFallbacks = Effect.fn("MobilePreferencesStore.clearFallbacks")(function* (
    warning: string,
  ) {
    for (const key of [PREFERENCES_FALLBACK_KEY, LEGACY_PREFERENCES_FALLBACK_KEY]) {
      yield* secureStorage
        .removeItem(key)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(warning).pipe(Effect.annotateLogs({ key, error })),
          ),
        );
    }
  });

  const saveJson = Effect.fn("MobilePreferencesStore.saveJson")(function* (
    payload: string,
    updatedAt?: number,
  ) {
    const timestamp = updatedAt ?? (yield* nextUpdatedAt);
    yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, timestamp));
    const databaseResult = yield* Effect.result(database.savePreferencesJson(payload, timestamp));

    if (Predicate.isTagged(databaseResult, "Failure")) {
      yield* Effect.logWarning("Database unavailable; saving preferences to secure storage.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
      const fallback = yield* encode(PREFERENCES_FALLBACK_KEY, { payload, updatedAt: timestamp });
      yield* secureStorage.setItem(PREFERENCES_FALLBACK_KEY, fallback);

      return;
    }

    yield* clearFallbacks("Could not remove the mobile preferences fallback.");
  });

  const loadUnlocked = Effect.gen(function* () {
    const databaseResult = yield* Effect.result(database.loadPreferencesJson);
    const databaseAvailable = Predicate.isTagged(databaseResult, "Success");

    const storedJson = databaseAvailable
      ? databaseResult.success
      : Option.none<MobileDatabase.StoredPreferencesJson>();

    if (Predicate.isTagged(databaseResult, "Failure")) {
      yield* Effect.logWarning("Database unavailable; loading fallback preferences.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
    }

    const fallbackResult = yield* Effect.result(
      secureStorage
        .getItem(PREFERENCES_FALLBACK_KEY)
        .pipe(
          Effect.flatMap((value) =>
            value !== null
              ? Effect.succeed(value)
              : secureStorage.getItem(LEGACY_PREFERENCES_FALLBACK_KEY),
          ),
        ),
    );

    let fallbackJson: string | null = null;

    if (Predicate.isTagged(fallbackResult, "Success")) {
      fallbackJson = fallbackResult.success;
    } else if (Option.isNone(storedJson)) {
      return yield* fallbackResult.failure;
    } else {
      yield* Effect.logWarning("Could not inspect the mobile preferences fallback.").pipe(
        Effect.annotateLogs({ error: fallbackResult.failure }),
      );
    }

    const fallback = parseFallback(fallbackJson);

    const storedPreferences = Option.isSome(storedJson)
      ? parsePayload(storedJson.value.payload)
      : null;

    const fallbackIsNewer =
      fallback !== null &&
      (storedPreferences === null ||
        (Option.isSome(storedJson) && fallback.updatedAt > storedJson.value.updatedAt));

    let parsed: typeof StoredPreferences.Type | null = null;

    if (fallbackIsNewer) {
      parsed = fallback.preferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, fallback.updatedAt));

      if (databaseAvailable) yield* saveJson(fallback.payload, fallback.updatedAt);
    } else if (storedPreferences !== null && Option.isSome(storedJson)) {
      parsed = storedPreferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, storedJson.value.updatedAt));

      if (fallbackJson !== null) {
        yield* clearFallbacks("Could not remove a stale mobile preferences fallback.");
      }
    }

    if (parsed === null) {
      const legacyJson = yield* secureStorage
        .getItem(PREFERENCES_KEY)
        .pipe(
          Effect.flatMap((value) =>
            value !== null ? Effect.succeed(value) : secureStorage.getItem(LEGACY_PREFERENCES_KEY),
          ),
        );

      const legacyPreferences = parsePayload(legacyJson);
      parsed = legacyPreferences;

      if (legacyJson !== null && legacyPreferences !== null && databaseAvailable) {
        yield* saveJson(legacyJson);
        yield* secureStorage
          .removeItem(PREFERENCES_KEY)
          .pipe(
            Effect.andThen(secureStorage.removeItem(LEGACY_PREFERENCES_KEY)),
            Effect.catch(() => Effect.void),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove migrated mobile preferences.").pipe(
                Effect.annotateLogs({ error }),
              ),
            ),
          );
      }
    }

    return parsed === null ? {} : sanitizePreferences(parsed);
  });

  const load = lock
    .withPermits(1)(loadUnlocked)
    .pipe(Effect.mapError((cause) => new MobilePreferencesLoadError({ cause })));

  const update = Effect.fn("MobilePreferencesStore.update")((transform) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadUnlocked;

          const patch = yield* Effect.try({
            try: () => transform(current),
            catch: (cause) => new MobilePreferencesSaveError({ cause }),
          });

          const next: Preferences = { ...current, ...patch };
          const payload = yield* encode(PREFERENCES_KEY, next);
          yield* saveJson(payload);

          return next;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof MobilePreferencesSaveError
            ? cause
            : new MobilePreferencesSaveError({ cause }),
        ),
      ),
  );

  return MobilePreferencesStore.of({
    load,
    update,
    savePatch: (patch) => update(() => patch),
  });
});

export const layer = Layer.effect(MobilePreferencesStore, make());
