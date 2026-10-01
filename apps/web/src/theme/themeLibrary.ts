import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
  type ThemeVariants,
} from "@akeru/shared/themePalettes";
import {
  isRecord,
  decodeThemeJson,
  isThemeColorRole,
  isThemeAppearance,
  isThemeId,
  RESERVED_THEME_IDS,
  isThemeLabel,
  parseThemeCollection,
  CUSTOM_THEMES_STORAGE_KEY,
  LEGACY_CUSTOM_THEMES_STORAGE_KEY,
} from "./themeTypes";
import { getDefaultThemeColors } from "./paletteGeneration";
import { toCanonicalThemeColor } from "./colorMath";
import { BUILT_IN_THEME_DEFINITIONS } from "./themeDefinitions";
import { canonicalizeThemeDefinition } from "./themeFiles";

const customThemeListeners = new Set<() => void>();

type CustomThemeLibrarySnapshot =
  | Readonly<{
      status: "ready";
      storedThemes: ReadonlyArray<Schema.Json>;
      themes: ReadonlyArray<ThemeDefinition>;
    }>
  | Readonly<{ status: "unavailable"; reason: "malformed" }>
  | Readonly<{ status: "unavailable"; reason: "storage-unavailable"; cause: unknown }>;

let customThemeLibrarySnapshot: CustomThemeLibrarySnapshot | null = null;

function parseStoredThemeColors(
  value: Schema.Json | undefined,
  appearance: ThemeAppearance,
): ThemeColors | null {
  if (!isRecord(value)) return null;

  const colors = {
    ...getDefaultThemeColors(appearance),
  };

  // Tolerate unknown roles and malformed values so themes saved by other
  // builds (for example one that adds a new role) keep their remaining colors.
  for (const [role, color] of Object.entries(value)) {
    const normalized = toCanonicalThemeColor(color);

    if (isThemeColorRole(role) && normalized) {
      colors[role] = normalized;
    }
  }

  return colors;
}

function parseStoredThemeVariants(
  value: Schema.Json | undefined,
  baseAppearance: ThemeAppearance,
): ThemeVariants | null | undefined {
  if (value === undefined) return undefined;

  if (!isRecord(value)) return null;

  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};

  for (const [appearance, colors] of Object.entries(value)) {
    if (!isThemeAppearance(appearance)) return null;

    // A variant matching the base appearance would be shadowed by the base
    // colors; drop it so the theme round-trips through parseThemeFile.
    if (appearance === baseAppearance) continue;
    const parsedColors = parseStoredThemeColors(colors, appearance);

    if (!parsedColors) return null;
    variants[appearance] = parsedColors;
  }

  return Object.keys(variants).length > 0 ? variants : undefined;
}

function parseStoredTheme(value: Schema.Json | undefined): ThemeDefinition | null {
  if (!isRecord(value)) return null;

  if (!isThemeId(value.id) || RESERVED_THEME_IDS.has(value.id)) return null;

  if (!isThemeLabel(value.label) || !isThemeAppearance(value.appearance)) return null;
  const colors = parseStoredThemeColors(value.colors, value.appearance);

  if (!colors) return null;
  const variants = parseStoredThemeVariants(value.variants, value.appearance);

  if (value.variants !== undefined && variants === null) return null;
  const collection = parseThemeCollection(value.collection);

  return {
    id: value.id,
    label: value.label.trim(),
    appearance: value.appearance,
    colors,
    ...(variants ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

function parseStoredThemes(
  storedThemes: ReadonlyArray<Schema.Json>,
): ReadonlyArray<ThemeDefinition> {
  const themes: ThemeDefinition[] = [];

  for (const value of storedThemes) {
    const theme = parseStoredTheme(value);

    if (theme && !themes.some((existing) => existing.id === theme.id)) {
      themes.push(theme);
    }
  }

  return themes;
}

/** Best-effort cleanup of a superseded storage key. A failed removal leaves a
 * harmless duplicate behind and must not fail the operation that already
 * landed. */
export function removeLegacyStorageKey(key: string): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(key);
  } catch {}
}

function readCustomThemeLibrarySnapshot(): CustomThemeLibrarySnapshot {
  if (typeof window === "undefined") {
    return { status: "ready", storedThemes: [], themes: [] };
  }

  let raw: string | null;

  try {
    raw =
      window.localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_CUSTOM_THEMES_STORAGE_KEY);
  } catch (cause) {
    return { status: "unavailable", reason: "storage-unavailable", cause };
  }

  if (!raw) return { status: "ready", storedThemes: [], themes: [] };

  let parsed: Schema.Json;

  try {
    const decoded = decodeThemeJson(JSON.parse(raw));

    if (Option.isNone(decoded)) return { status: "unavailable", reason: "malformed" };
    parsed = decoded.value;
  } catch {
    return { status: "unavailable", reason: "malformed" };
  }

  if (!Array.isArray(parsed)) return { status: "unavailable", reason: "malformed" };

  return { status: "ready", storedThemes: parsed, themes: parseStoredThemes(parsed) };
}

function getCustomThemeLibrarySnapshot(): CustomThemeLibrarySnapshot {
  if (customThemeLibrarySnapshot === null) {
    customThemeLibrarySnapshot = readCustomThemeLibrarySnapshot();
  }

  return customThemeLibrarySnapshot;
}

function notifyCustomThemeListeners() {
  for (const listener of customThemeListeners) listener();
}

export function invalidateCustomThemes() {
  customThemeLibrarySnapshot = null;
  notifyCustomThemeListeners();
}

export function getCustomThemes(): ReadonlyArray<ThemeDefinition> {
  const snapshot = getCustomThemeLibrarySnapshot();

  return snapshot.status === "ready" ? snapshot.themes : [];
}

export function getStoredCustomThemeCollection(
  collectionId: string,
): ReadonlyArray<ThemeDefinition> {
  return readWritableCustomThemeLibrary().themes.filter(
    (theme) => theme.collection?.id === collectionId,
  );
}

export function subscribeToCustomThemes(listener: () => void): () => void {
  customThemeListeners.add(listener);

  if (typeof window === "undefined") {
    return () => customThemeListeners.delete(listener);
  }

  const handleStorage = (event: StorageEvent) => {
    if (
      event.key === CUSTOM_THEMES_STORAGE_KEY ||
      event.key === LEGACY_CUSTOM_THEMES_STORAGE_KEY ||
      event.key === null
    ) {
      invalidateCustomThemes();
    }
  };

  window.addEventListener("storage", handleStorage);

  return () => {
    customThemeListeners.delete(listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export class ThemeLibraryStorageError extends Schema.TaggedErrorClass<ThemeLibraryStorageError>()(
  "ThemeLibraryStorageError",
  {
    storageKey: Schema.String,
    operation: Schema.Literals(["read", "write"]),
    reason: Schema.Literals(["malformed", "storage-unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const direction = this.operation === "read" ? "from" : "to";

    return `Failed to ${this.operation} the theme library ${direction} ${this.storageKey}.`;
  }
}

export const isThemeLibraryStorageError = Schema.is(ThemeLibraryStorageError);

function saveCustomThemes(
  storedThemes: ReadonlyArray<Schema.Json>,
  themes: ReadonlyArray<ThemeDefinition>,
): void {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify(storedThemes));
    removeLegacyStorageKey(LEGACY_CUSTOM_THEMES_STORAGE_KEY);
    customThemeLibrarySnapshot = { status: "ready", storedThemes, themes };
  } catch (cause) {
    throw new ThemeLibraryStorageError({
      storageKey: CUSTOM_THEMES_STORAGE_KEY,
      operation: "write",
      reason: "storage-unavailable",
      cause,
    });
  }

  notifyCustomThemeListeners();
}

function requireWritableCustomThemeLibrary(
  snapshot: CustomThemeLibrarySnapshot,
): Extract<CustomThemeLibrarySnapshot, { status: "ready" }> {
  if (snapshot.status === "unavailable") {
    throw new ThemeLibraryStorageError({
      storageKey: CUSTOM_THEMES_STORAGE_KEY,
      operation: "read",
      reason: snapshot.reason,
      ...("cause" in snapshot ? { cause: snapshot.cause } : {}),
    });
  }

  return snapshot;
}

function getWritableCustomThemeLibrary(): Extract<CustomThemeLibrarySnapshot, { status: "ready" }> {
  return requireWritableCustomThemeLibrary(getCustomThemeLibrarySnapshot());
}

function readWritableCustomThemeLibrary(): Extract<
  CustomThemeLibrarySnapshot,
  { status: "ready" }
> {
  return requireWritableCustomThemeLibrary(readCustomThemeLibrarySnapshot());
}

function storedThemeHasId(storedTheme: Schema.Json, themeId: string): boolean {
  return isRecord(storedTheme) && storedTheme.id === themeId;
}

function storedThemeHasCollectionId(storedTheme: Schema.Json, collectionId: string): boolean {
  return (
    isRecord(storedTheme) &&
    isRecord(storedTheme.collection) &&
    storedTheme.collection.id === collectionId
  );
}

export function installCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }

  const library = getWritableCustomThemeLibrary();

  if (
    BUILT_IN_THEME_DEFINITIONS.some((existing) => existing.id === theme.id) ||
    library.storedThemes.some((storedTheme) => storedThemeHasId(storedTheme, theme.id))
  ) {
    throw new Error(`A theme named "${theme.label}" is already installed.`);
  }

  const canonicalTheme = canonicalizeThemeDefinition(theme);
  const themes = [...library.themes, canonicalTheme];
  saveCustomThemes([...library.storedThemes, canonicalTheme], themes);

  return canonicalTheme;
}

export function updateCustomTheme(theme: ThemeDefinition): ThemeDefinition {
  if (RESERVED_THEME_IDS.has(theme.id)) {
    throw new Error(`The theme id "${theme.id}" is reserved.`);
  }

  const library = getWritableCustomThemeLibrary();
  const themes = library.themes;
  const themeIndex = themes.findIndex((existing) => existing.id === theme.id);

  if (themeIndex === -1) {
    throw new Error(`The theme "${theme.label}" is not installed.`);
  }

  const canonicalTheme = canonicalizeThemeDefinition(theme);
  const nextThemes = [...themes];
  nextThemes[themeIndex] = canonicalTheme;

  const nextStoredThemes: Schema.Json[] = [];
  let replaced = false;

  for (const storedTheme of library.storedThemes) {
    if (!storedThemeHasId(storedTheme, theme.id)) {
      nextStoredThemes.push(storedTheme);
    } else if (!replaced) {
      nextStoredThemes.push(canonicalTheme);
      replaced = true;
    }
  }

  saveCustomThemes(nextStoredThemes, nextThemes);

  return canonicalTheme;
}

export function replaceCustomThemeCollection(
  collectionId: string,
  themes: ReadonlyArray<ThemeDefinition>,
  options?: { expectedCollection?: ReadonlyArray<ThemeDefinition> },
): ReadonlyArray<ThemeDefinition> {
  if (themes.length === 0) throw new Error("A theme collection cannot be empty.");

  const validated = themes.map((theme) => parseStoredTheme(theme));

  if (
    validated.some((theme) => theme === null || theme.collection?.id !== collectionId) ||
    new Set(validated.map((theme) => theme?.id)).size !== validated.length
  ) {
    throw new Error("That theme collection is invalid.");
  }

  const replacement = validated.filter((theme) => theme !== null);
  const library = readWritableCustomThemeLibrary();
  const current = library.themes;
  const currentCollection = current.filter((theme) => theme.collection?.id === collectionId);

  if (
    options?.expectedCollection &&
    JSON.stringify(currentCollection) !== JSON.stringify(options.expectedCollection)
  ) {
    throw new Error("Your installed themes changed while this package was downloading. Try again.");
  }

  const occupiedIds = new Set(BUILT_IN_THEME_DEFINITIONS.map((theme) => theme.id));

  for (const storedTheme of library.storedThemes) {
    if (
      !storedThemeHasCollectionId(storedTheme, collectionId) &&
      isRecord(storedTheme) &&
      Predicate.isString(storedTheme.id)
    ) {
      occupiedIds.add(storedTheme.id);
    }
  }

  const conflictingTheme = replacement.find(
    (theme) => RESERVED_THEME_IDS.has(theme.id) || occupiedIds.has(theme.id),
  );

  if (conflictingTheme) {
    throw new Error(`A theme named "${conflictingTheme.label}" is already installed.`);
  }

  const nextStoredThemes: Schema.Json[] = [];
  let insertedReplacement = false;

  for (const storedTheme of library.storedThemes) {
    if (!storedThemeHasCollectionId(storedTheme, collectionId)) {
      nextStoredThemes.push(storedTheme);
    } else if (!insertedReplacement) {
      nextStoredThemes.push(...replacement);
      insertedReplacement = true;
    }
  }

  if (!insertedReplacement) nextStoredThemes.push(...replacement);

  saveCustomThemes(nextStoredThemes, parseStoredThemes(nextStoredThemes));

  return replacement;
}

export function removeCustomTheme(themeId: string): void {
  removeCustomThemes([themeId]);
}

export function removeCustomThemes(themeIds: ReadonlyArray<string>): void {
  const removedIds = new Set(themeIds);

  if (removedIds.size === 0) return;
  const library = getWritableCustomThemeLibrary();
  const nextThemes = library.themes.filter((theme) => !removedIds.has(theme.id));

  if (nextThemes.length === library.themes.length) return;
  saveCustomThemes(
    library.storedThemes.filter(
      (storedTheme) =>
        !isRecord(storedTheme) ||
        !Predicate.isString(storedTheme.id) ||
        !removedIds.has(storedTheme.id),
    ),
    nextThemes,
  );
}
