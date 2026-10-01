// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const css = NodeFS.readFileSync(new URL("./index.css", import.meta.url), "utf8");

const themeTokensCss = NodeFS.readFileSync(
  new URL("./styles/theme-tokens.css", import.meta.url),
  "utf8",
);

// The base theme block: light declarations, then its nested dark variant.
const baseTheme = themeTokensCss.match(
  /:root \{\n {2}color-scheme: light;[\s\S]*?\n {2}@variant dark \{[\s\S]*?\n {2}\}/,
)?.[0];

const [light = "", dark = ""] = baseTheme?.split("@variant dark {") ?? [];

function tokenValue(block: string, token: string) {
  return block.match(new RegExp(`\\n\\s*--${token}:\\s*([^;]+);`))?.[1];
}

describe("status color tokens", () => {
  it("keeps the exact palette shades the primitives rendered before tokenization", () => {
    expect(baseTheme).toBeDefined();
    expect(tokenValue(light, "success-indicator-foreground")).toBe("var(--color-emerald-600)");
    expect(tokenValue(dark, "success-indicator-foreground")).toBe("var(--color-emerald-400)");
    expect(tokenValue(light, "success-bright-foreground")).toBe("var(--color-emerald-300)");
    expect(tokenValue(light, "warning-bright-foreground")).toBe("var(--color-amber-300)");
    expect(tokenValue(light, "favorite-foreground")).toBe("var(--color-yellow-500)");
    expect(tokenValue(light, "favorite-hover-foreground")).toBe("var(--color-yellow-600)");

    for (const token of [
      "success-bright-foreground",
      "warning-bright-foreground",
      "favorite-foreground",
      "favorite-hover-foreground",
    ]) {
      expect(tokenValue(dark, token)).toBeUndefined();
    }
  });

  it("maps each status token to a Tailwind color utility", () => {
    for (const token of [
      "success-indicator-foreground",
      "success-bright-foreground",
      "warning-bright-foreground",
      "favorite-foreground",
      "favorite-hover-foreground",
    ]) {
      expect(css).toContain(`--color-${token}: var(--${token});`);
    }
  });
});
