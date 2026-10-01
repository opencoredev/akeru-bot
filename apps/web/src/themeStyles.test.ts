import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { readAppStyles } from "./styles.test-support";
import { afterEach, expect, it as unitIt, vi } from "vite-plus/test";
import {
  AKERU_PAPER_THEME,
  applyThemeColorPreview,
  applyThemePalette,
  getThemeColorsForMode,
} from "./themePalette";

afterEach(() => {
  applyThemePalette("system");
  vi.unstubAllGlobals();
});

unitIt.each(["light", "dark"] as const)(
  "applies %s terminal scrollbar colors and custom previews",
  (appearance) => {
    const properties = new Map<string, string>();
    vi.stubGlobal("document", {
      documentElement: {
        dataset: {},
        classList: { toggle: vi.fn() },
        style: {
          setProperty: (name: string, value: string) => properties.set(name, value),
          removeProperty: (name: string) => properties.delete(name),
        },
      },
    });

    applyThemePalette(AKERU_PAPER_THEME.id, appearance);
    const colors = getThemeColorsForMode(AKERU_PAPER_THEME, appearance)!;
    expect(properties.get("--app-theme-terminal-scrollbar")).toBe(colors.terminalScrollbar);
    expect(properties.get("--app-theme-terminal-scrollbar-hover")).toBe(
      colors.terminalScrollbarHover,
    );

    applyThemeColorPreview(
      { ...colors, terminalScrollbar: "#123456", terminalScrollbarHover: "#234567" },
      appearance,
    );
    expect(properties.get("--app-theme-terminal-scrollbar")).toBe("#123456");
    expect(properties.get("--app-theme-terminal-scrollbar-hover")).toBe("#234567");
  },
);

it.effect("maps terminal scrollbar roles without recoloring ordinary scrollbars", () =>
  Effect.gen(function* () {
    const css = yield* readAppStyles;

    expect(css).toContain("--terminal-scrollbar: var(--app-scrollbar-thumb)");
    expect(css).toContain("--terminal-scrollbar-hover: var(--app-scrollbar-thumb-hover)");
    expect(css).toContain("--terminal-scrollbar: var(--app-theme-terminal-scrollbar)");
    expect(css).toContain("--terminal-scrollbar-hover: var(--app-theme-terminal-scrollbar-hover)");
    expect(css).toContain("background: var(--terminal-scrollbar)");
    expect(css).toContain("background: var(--terminal-scrollbar-hover)");
    expect(css).toContain("background: var(--app-scrollbar-thumb)");
    expect(css).not.toContain("--app-scrollbar-thumb: var(--app-theme-terminal-scrollbar)");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps long-lived status labels and skeletons static", () =>
  Effect.gen(function* () {
    const css = yield* readAppStyles;

    expect(css).toContain("--animate-skeleton: none");
    expect(css).not.toContain("animation: bot-status-shimmer");
    expect(css).not.toContain("animation: bot-shimmer-sheen");
  }).pipe(Effect.provide(NodeServices.layer)),
);
