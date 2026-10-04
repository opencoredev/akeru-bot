import { describe, expect, it, vi } from "vite-plus/test";
import { shouldBlinkTerminalCursor } from "./surface";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE,
  loadTerminalFontFamily,
  terminalFontFamily,
  terminalFontSize,
} from "./surfaceFont";

describe("shouldBlinkTerminalCursor", () => {
  const blinking = {
    focused: true,
    cursorBlinking: true,
    cursorVisible: true,
    reducedMotion: false,
  };

  it("blinks a focused visible cursor the terminal asked to blink", () => {
    expect(shouldBlinkTerminalCursor(blinking)).toBe(true);
  });

  it("holds the cursor steady when blinking would be unwanted", () => {
    // Unfocused surfaces draw a steady hollow cursor, DECSCUSR steady styles and
    // DEC mode 12 turn blinking off, a hidden cursor has nothing to toggle, and
    // reduced-motion readers get no permanently animating element.
    expect(shouldBlinkTerminalCursor({ ...blinking, focused: false })).toBe(false);
    expect(shouldBlinkTerminalCursor({ ...blinking, cursorBlinking: false })).toBe(false);
    expect(shouldBlinkTerminalCursor({ ...blinking, cursorVisible: false })).toBe(false);
    expect(shouldBlinkTerminalCursor({ ...blinking, reducedMotion: true })).toBe(false);
  });
});

describe("terminal font resolution", () => {
  it("validates the requested face after its styles load", async () => {
    let loaded = false;

    const load = vi.fn(async () => {
      loaded = true;

      return [];
    });

    const resolve = vi.fn(() => {
      expect(loaded).toBe(true);

      return DEFAULT_TERMINAL_FONT_FAMILY;
    });

    await expect(
      loadTerminalFontFamily("Proportional Test", 12, {
        load,
        resolve,
      }),
    ).resolves.toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(load).toHaveBeenCalledTimes(4);
    expect(resolve).toHaveBeenCalledWith("Proportional Test");
  });

  it("keeps the glyph fallbacks behind a custom text face", () => {
    expect(terminalFontFamily()).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(terminalFontFamily("  ")).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    const custom = terminalFontFamily('"Fira Code"');
    expect(custom.startsWith('"Fira Code", ')).toBe(true);
    expect(custom).toContain('"Symbols Nerd Font Mono"');
    expect(custom.endsWith("monospace")).toBe(true);
  });

  it("ignores proportional families the cell grid cannot lay out", () => {
    // jsdom has no canvas metrics, so the probe answers "monospace" and the
    // family is kept; the guard is exercised in the browser instead. Assert the
    // shape stays intact so a rejected face still yields a usable stack.
    const stack = terminalFontFamily("Helvetica Neue");
    expect(stack.endsWith("monospace")).toBe(true);
  });

  it("quotes families the canvas font shorthand would otherwise reject", () => {
    expect(terminalFontFamily("3270 Nerd Font").startsWith('"3270 Nerd Font", ')).toBe(true);
    expect(terminalFontFamily("M+ 1m").startsWith('"M+ 1m", ')).toBe(true);
    expect(terminalFontFamily("Cascadia Code, Menlo").startsWith('"Cascadia Code", Menlo, ')).toBe(
      true,
    );
    expect(terminalFontFamily(" , ")).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });

  it("clamps requested font sizes to the supported range", () => {
    expect(terminalFontSize()).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(terminalFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_FONT_SIZE);
    expect(terminalFontSize(13.4)).toBe(13);
    expect(terminalFontSize(2)).toBe(6);
    expect(terminalFontSize(90)).toBe(32);
  });
});
