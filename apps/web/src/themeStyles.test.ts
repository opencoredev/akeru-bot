import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { compile } from "tailwindcss";
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

it.effect("keeps terminal thumbs on the original app scrollbar colors", () =>
  Effect.gen(function* () {
    const css = yield* readAppStyles;

    expect(css).toContain("--terminal-scrollbar: var(--app-scrollbar-thumb)");
    expect(css).toContain("--terminal-scrollbar-hover: var(--app-scrollbar-thumb-hover)");
    expect(css).toContain("--terminal-scrollbar: var(--app-theme-terminal-scrollbar)");
    expect(css).toContain("--terminal-scrollbar-hover: var(--app-theme-terminal-scrollbar-hover)");
    expect(css).not.toContain("background: var(--terminal-scrollbar)");
    expect(css).not.toContain("background: var(--terminal-scrollbar-hover)");
    expect(css).toContain("background: var(--app-scrollbar-thumb-hover)");
    expect(css).toContain("background: var(--app-scrollbar-thumb)");
    expect(css).not.toContain("--app-scrollbar-thumb: var(--app-theme-terminal-scrollbar)");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preserves nominal indicator and alert colors in both default appearances", () =>
  Effect.gen(function* () {
    const css = yield* readAppStyles;

    const roles = [
      ["markdown-note", "blue-500", "blue-500"],
      ["markdown-note-foreground", "blue-600", "blue-400"],
      ["markdown-tip", "emerald-500", "emerald-500"],
      ["markdown-tip-foreground", "emerald-600", "emerald-400"],
      ["markdown-important", "purple-500", "purple-500"],
      ["markdown-important-foreground", "purple-600", "purple-400"],
      ["markdown-warning", "amber-500", "amber-500"],
      ["markdown-warning-foreground", "amber-600", "amber-500"],
      ["markdown-caution", "red-500", "red-500"],
      ["markdown-caution-foreground", "red-600", "red-400"],
      ["computer-control-indicator", "amber-500", "amber-500"],
      ["quit-prompt", "neutral-700", "neutral-700"],
      ["plugin-connected", "emerald-500", "emerald-500"],
      ["memory-approval-indicator", "amber-400", "amber-400"],
      ["telemetry-status-foreground", "amber-700", "amber-300"],
    ];

    for (const [role, light, dark] of roles) {
      expect(css).toContain(`--color-${role}: var(--${role})`);

      const values = [...css.matchAll(new RegExp(`--${role}: var\\(--color-([^)]*)\\)`, "g"))].map(
        (match) => match[1],
      );

      expect(values).toEqual(light === dark ? [light] : [light, dark]);
    }

    expect(css).toContain("--on-solid: var(--color-white)");
    expect(css).toContain("--telemetry-monitor: var(--color-amber-500)");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("uses parity tokens and opacities at the reviewed component sites", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    const consumers = [
      [
        "components/ChatMarkdown.tsx",
        "border-markdown-note/70",
        "text-markdown-note-foreground",
        "border-markdown-tip/70",
        "text-markdown-tip-foreground",
        "border-markdown-important/70",
        "text-markdown-important-foreground",
        "border-markdown-warning/70",
        "text-markdown-warning-foreground",
        "border-markdown-caution/70",
        "text-markdown-caution-foreground",
      ],
      [
        "components/sidebar/SidebarChrome.tsx",
        "border-computer-control-indicator/30",
        "bg-computer-control-indicator/10",
        "bg-computer-control-indicator",
      ],
      ["components/QuitHoldOverlay.tsx", "bg-quit-prompt/95", "text-on-solid"],
      ["components/chat/PluginSearchResultCard.tsx", "text-plugin-connected"],
      ["components/roster/BotPromptAttachments.tsx", "border-on-solid/10"],
      ["components/roster/MemoryApprovalPrompt.tsx", "bg-memory-approval-indicator"],
      ["components/settings/ProcessResourceHistory.tsx", "bg-telemetry-monitor/90"],
      ["components/settings/ResourceTelemetrySummary.tsx", "bg-telemetry-monitor"],
      [
        "components/ui/badge.tsx",
        "border-telemetry-monitor/30",
        "bg-telemetry-monitor/10",
        "text-telemetry-status-foreground",
      ],
    ];

    for (const [path, ...classes] of consumers) {
      const source = yield* fileSystem.readFileString(
        decodeURIComponent(new URL(path!, import.meta.url).pathname),
      );

      for (const className of classes) {
        expect(source).toContain(className);
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("compiles severity banner tints after the transparent glass default", () =>
  Effect.gen(function* () {
    const css = yield* readAppStyles;

    const utilities = [
      "composer-banner-glass",
      "composer-banner-outline-error",
      "composer-banner-outline-warning",
    ];

    const definitions = utilities
      .map((name) => {
        const start = css.indexOf(`@utility ${name} {`);
        const end = css.indexOf("\n@utility ", start + 1);

        return css.slice(start, end);
      })
      .join("\n");

    const compiler = yield* Effect.promise(() =>
      compile(`@custom-variant dark (&:is(.dark, .dark *));\n@tailwind utilities;\n${definitions}`),
    );

    const output = compiler.build(utilities);
    const glass = output.indexOf(".composer-banner-glass {");

    for (const severity of ["error", "warning"]) {
      const start = output.indexOf(`.composer-banner-outline-${severity} {`);
      expect(start).toBeGreaterThan(glass);

      const rule = output.slice(
        start,
        output.indexOf("\n.", start + 1) === -1 ? undefined : output.indexOf("\n.", start + 1),
      );

      expect(rule).toContain(
        `--chat-composer-attached-tint: color-mix(in srgb, var(--${severity}) 8%, transparent)`,
      );
    }
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
