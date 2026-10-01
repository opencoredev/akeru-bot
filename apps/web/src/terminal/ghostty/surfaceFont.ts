import symbolsFontUrl from "./fonts/SymbolsNerdFontMono-Regular.woff2?url";
import { isMonospaceFamily } from "../../appearanceFonts";

export const DEFAULT_TERMINAL_FONT_SIZE = 12;

const MIN_TERMINAL_FONT_SIZE = 6;

const MAX_TERMINAL_FONT_SIZE = 32;

// The glyph fallbacks only supply symbols the text faces are missing (powerline
// separators, devicons, and other private-use prompt symbols), so shells
// configured for a locally installed Nerd Font keep their prompt glyphs no
// matter which text face is active.
const TERMINAL_GLYPH_FALLBACKS =
  '"Symbols Nerd Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font", ' +
  '"JetBrainsMono NF", "FiraCode Nerd Font", "Hack Nerd Font", "MesloLGS NF", ' +
  '"CaskaydiaCove Nerd Font", "PowerlineSymbols", monospace';

// The platform's own monospace faces; concrete names only, because an
// unknown keyword (like ui-monospace) makes canvas font shorthand parsing
// reject the whole string.
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", ' + TERMINAL_GLYPH_FALLBACKS;

const TERMINAL_FONT_LOAD_TEXT = "iMW0@# .";

const TERMINAL_FONT_LOAD_VARIANTS = [
  "normal 400",
  "normal 700",
  "italic 400",
  "italic 700",
] as const;

/** Requested terminal font; omitted fields fall back to the defaults. */
export interface GhosttyTerminalFont {
  readonly family?: string;
  readonly size?: number;
}

let symbolsFontLoad: Promise<void> | null = null;

/**
 * Register the bundled symbols-only Nerd Font once per page. It loads lazily
 * with the first terminal, and because it carries no regular text glyphs it
 * composes with any text face without changing metrics — prompt symbols and
 * devicons render even on machines without a locally installed Nerd Font.
 */
export function ensureTerminalSymbolsFont(): Promise<void> {
  if (symbolsFontLoad !== null) return symbolsFontLoad;
  symbolsFontLoad = (async () => {
    try {
      const face = new FontFace("Symbols Nerd Font Mono", `url(${symbolsFontUrl})`);
      document.fonts.add(await face.load());
    } catch {
      // Locally installed fallback faces still apply.
    }
  })();

  return symbolsFontLoad;
}

function quoteTerminalFontFamilies(list: string): string {
  return list
    .split(",")
    .map((name) => {
      const bare = name.trim();

      if (bare.length === 0) return "";

      if (/^(['"]).*\1$/.test(bare)) return bare;

      if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;

      return `"${bare.replaceAll('"', "")}"`;
    })
    .filter((name) => name.length > 0)
    .join(", ");
}

function uncheckedTerminalFontFamily(family?: string): string {
  const custom = family === undefined ? "" : quoteTerminalFontFamilies(family);

  return custom.length === 0
    ? DEFAULT_TERMINAL_FONT_FAMILY
    : `${custom}, ${TERMINAL_GLYPH_FALLBACKS}`;
}

export function terminalFontFamily(family?: string): string {
  // Quote non-ident names ("3270 Nerd Font", "M+ 1m"): an unquoted one makes
  // the whole canvas font string invalid and the assignment silently no-ops.
  const custom = family === undefined ? "" : quoteTerminalFontFamilies(family);

  if (custom.length === 0) return DEFAULT_TERMINAL_FONT_FAMILY;

  // The grid places the cursor and selection on one cell advance, so a
  // proportional face would draw its text narrower than its own cells. Refuse
  // it here rather than render a ragged grid with a stranded cursor.
  if (!isMonospaceFamily(custom)) return DEFAULT_TERMINAL_FONT_FAMILY;

  // A custom face keeps the glyph fallbacks so prompt symbols stay covered.
  return uncheckedTerminalFontFamily(custom);
}

/** Load every style the renderer can request, then validate the actual face. */
export async function loadTerminalFontFamily(
  family: string | undefined,
  size: number,
  environment?: {
    readonly load: (font: string, text: string) => Promise<ReadonlyArray<FontFace> | void>;
    readonly resolve: (family: string | undefined) => string;
  },
): Promise<string> {
  const candidate = uncheckedTerminalFontFamily(family);

  const load =
    environment?.load ?? ((font: string, text: string) => document.fonts.load(font, text));

  try {
    await Promise.all(
      TERMINAL_FONT_LOAD_VARIANTS.map((variant) =>
        load(`${variant} ${size}px ${candidate}`, TERMINAL_FONT_LOAD_TEXT),
      ),
    );
  } catch {
    // The fixed-width fallback stack remains available if a face cannot load.
  }

  return (environment?.resolve ?? terminalFontFamily)(family);
}

export function terminalFontSize(size?: number): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;

  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(size)));
}
