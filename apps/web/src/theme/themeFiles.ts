import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  THEME_COLOR_ROLES,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
  type ThemeDefinition,
} from "@akeru/shared/themePalettes";
import { toCanonicalThemeColor } from "./colorMath";
import {
  type ThemeColorOverrides,
  isRecord,
  decodeThemeJson,
  isThemeColorRole,
  THEME_FILE_VERSION,
  isThemeLabel,
  isThemeAppearance,
  isThemeId,
  RESERVED_THEME_IDS,
  parseThemeCollection,
  type ThemeFile,
} from "./themeTypes";
import { themeIdFromName } from "./themeDefinitions";
import { getDefaultThemeColors } from "./paletteGeneration";

export function decodeThemeColors(colors: ThemeColors): ThemeColors {
  const normalized = { ...colors };

  for (const role of THEME_COLOR_ROLES) {
    const color = toCanonicalThemeColor(colors[role]);

    if (!color) {
      throw new Error(
        `The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`,
      );
    }

    normalized[role] = color;
  }

  return normalized;
}

export function canonicalizeThemeDefinition(theme: ThemeDefinition): ThemeDefinition {
  return {
    ...theme,
    colors: decodeThemeColors(theme.colors),
    ...(theme.variants
      ? {
          variants: Object.fromEntries(
            Object.entries(theme.variants).map(([appearance, colors]) => [
              appearance,
              decodeThemeColors(colors),
            ]),
          ),
        }
      : {}),
  };
}

function parseThemeColorOverrides(value: Schema.Json | undefined): ThemeColorOverrides {
  if (!isRecord(value)) throw new Error("Theme colors must be objects.");

  const overrides: Partial<Record<ThemeColorRole, string>> = {};

  for (const [role, color] of Object.entries(value)) {
    if (!isThemeColorRole(role)) {
      throw new Error(`"${role}" is not a supported theme color role.`);
    }

    const normalized = toCanonicalThemeColor(color);

    if (!normalized) {
      throw new Error(
        `The color for "${role}" must be a literal CSS color such as oklch(0.62 0.2 280).`,
      );
    }

    overrides[role] = normalized;
  }

  if (Object.keys(overrides).length === 0) {
    throw new Error("Add at least one color role to the theme file.");
  }

  return overrides;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This public import boundary decodes external JSON before interpreting theme fields.
export function parseThemeFile(input: unknown): ThemeDefinition {
  const decoded = decodeThemeJson(input);
  const value = Option.isSome(decoded) ? decoded.value : null;

  if (!isRecord(value)) {
    throw new Error("Theme files must contain a JSON object.");
  }

  if (value.version !== THEME_FILE_VERSION) {
    throw new Error(`This theme file uses an unsupported version. Expected ${THEME_FILE_VERSION}.`);
  }

  const name = value.name;
  const appearance = value.appearance;
  const rawColors = value.colors;

  if (!isThemeLabel(name)) throw new Error("Theme files need a name (48 characters or fewer).");

  if (!isThemeAppearance(appearance)) {
    throw new Error('Theme files need an appearance of "light" or "dark".');
  }

  if (!isRecord(rawColors)) throw new Error("Theme files need a colors object.");

  const id = value.id === undefined ? themeIdFromName(name) : value.id;

  if (!isThemeId(id)) {
    throw new Error("Theme ids may only contain lowercase letters, numbers, and hyphens.");
  }

  if (RESERVED_THEME_IDS.has(id)) {
    throw new Error(`The theme id "${id}" is reserved.`);
  }

  const overrides = parseThemeColorOverrides(rawColors);
  const collection = parseThemeCollection(value.collection);

  if (value.collection !== undefined && !collection) {
    throw new Error("Theme collections need a valid id and label.");
  }

  const fallback = getDefaultThemeColors(appearance);
  const variants: Partial<Record<ThemeAppearance, ThemeColors>> = {};

  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");

    for (const [variantAppearance, variantColors] of Object.entries(value.variants)) {
      if (!isThemeAppearance(variantAppearance)) {
        throw new Error('Theme variants may only be named "light" or "dark".');
      }

      if (variantAppearance === appearance) {
        throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      }

      const variantFallback = getDefaultThemeColors(variantAppearance);
      variants[variantAppearance] = {
        ...variantFallback,
        ...parseThemeColorOverrides(variantColors),
      };
    }
  }

  return {
    id,
    label: name.trim(),
    appearance,
    colors: { ...fallback, ...overrides },
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
  };
}

export function serializeThemeFile(theme: ThemeDefinition): string {
  const canonicalTheme = canonicalizeThemeDefinition(theme);

  const file: ThemeFile = {
    version: THEME_FILE_VERSION,
    id: canonicalTheme.id,
    name: canonicalTheme.label,
    appearance: canonicalTheme.appearance,
    colors: canonicalTheme.colors,
    ...(canonicalTheme.variants ? { variants: canonicalTheme.variants } : {}),
    ...(canonicalTheme.collection ? { collection: canonicalTheme.collection } : {}),
    ...(canonicalTheme.managed ? { managed: true } : {}),
  };

  return `${JSON.stringify(file, null, 2)}\n`;
}
