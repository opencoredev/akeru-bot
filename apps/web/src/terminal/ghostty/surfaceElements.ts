import type { GhosttyTheme } from "./core";

function createTerminalScrollbarElements() {
  const scrollbar = document.createElement("div");
  scrollbar.className =
    "group absolute top-1 right-px bottom-1 z-1 w-[var(--app-scrollbar-width)] cursor-default touch-none";
  scrollbar.setAttribute("role", "scrollbar");
  scrollbar.setAttribute("aria-label", "Terminal scrollback");
  scrollbar.setAttribute("aria-orientation", "vertical");
  scrollbar.tabIndex = 0;
  scrollbar.hidden = true;
  const scrollbarThumb = document.createElement("div");
  scrollbarThumb.className = "terminal-scrollbar-thumb";
  scrollbar.append(scrollbarThumb);

  return { scrollbar, scrollbarThumb };
}

/**
 * Replaces the mount's children with the terminal canvas, the hidden IME
 * textarea, and the overlay scrollbar, and paints the theme background so the
 * mount never shows a black box while fonts and WASM load.
 */
export function mountGhosttySurfaceElements(mount: HTMLElement, theme: GhosttyTheme) {
  const canvas = document.createElement("canvas");
  canvas.className = "block size-full cursor-text";
  canvas.setAttribute("aria-hidden", "true");

  const input = document.createElement("textarea");
  input.className = "t3-ghostty-input";
  input.setAttribute("aria-label", "Terminal input");
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.style.cssText =
    "position:absolute;left:4px;top:4px;width:1px;height:1px;opacity:0;padding:0;border:0;resize:none;pointer-events:none;";

  const { scrollbar, scrollbarThumb } = createTerminalScrollbarElements();
  mount.replaceChildren(canvas, input, scrollbar);

  const context = canvas.getContext("2d", { alpha: false });

  if (!context) throw new Error("Canvas 2D is unavailable");
  // An opaque canvas backing store initializes to solid black, and the font
  // and WASM loads leave it on screen for the whole setup window; paint the
  // theme background first so the mount never flashes a black box.
  context.fillStyle = `rgb(${theme.background.r}, ${theme.background.g}, ${theme.background.b})`;
  context.fillRect(0, 0, canvas.width, canvas.height);

  return { canvas, input, scrollbar, scrollbarThumb, context };
}
