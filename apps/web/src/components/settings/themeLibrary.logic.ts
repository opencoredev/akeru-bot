import type { ThemeAppearance, ThemeDefinition } from "../../themePalette";
import type { ThemeMode } from "./ThemePreviewCircles";

export function resolveSelectedThemeCardId(input: {
  readonly appearanceMode: ThemeMode;
  readonly initialAppearance: ThemeAppearance;
  readonly lightOwner: string | null;
  readonly darkOwner: string | null;
}): string | null {
  if (input.appearanceMode === "dark") return input.darkOwner;
  if (input.appearanceMode === "light") return input.lightOwner;
  return input.initialAppearance === "dark" ? input.darkOwner : input.lightOwner;
}

export function standardThemePreference(
  appearanceMode: ThemeMode,
  initialAppearance: ThemeAppearance,
): ThemeMode {
  return appearanceMode === "system" ? initialAppearance : appearanceMode;
}

/** Short per-variant labels: the words every label in the collection shares are dropped. */
export function collectionVariantLabels(
  themes: ReadonlyArray<ThemeDefinition>,
): ReadonlyArray<string> {
  if (themes.length === 0) return [];
  const words = themes.map((theme) => theme.label.trim().split(/\s+/));
  const firstWords = words[0]!;
  const sharedWordCount = firstWords.findIndex((word, index) =>
    words.some((labelWords) => labelWords[index]?.toLocaleLowerCase() !== word.toLocaleLowerCase()),
  );
  const prefixLength = sharedWordCount === -1 ? firstWords.length - 1 : sharedWordCount;

  return themes.map((theme, index) => {
    const shortLabel = words[index]?.slice(Math.max(0, prefixLength)).join(" ").trim();
    return shortLabel || theme.label;
  });
}

/**
 * Groups custom themes by collection, in first-seen order; a theme without a
 * collection is its own group. Keys are stable React keys.
 */
export function groupCustomThemeCollections(
  customThemes: ReadonlyArray<ThemeDefinition>,
): ReadonlyArray<readonly [string, ReadonlyArray<ThemeDefinition>]> {
  const groups = new Map<string, ThemeDefinition[]>();
  for (const customTheme of customThemes) {
    const groupId = customTheme.collection
      ? `collection:${customTheme.collection.id}`
      : `theme:${customTheme.id}`;
    const group = groups.get(groupId);
    if (group) group.push(customTheme);
    else groups.set(groupId, [customTheme]);
  }
  return [...groups.entries()];
}
