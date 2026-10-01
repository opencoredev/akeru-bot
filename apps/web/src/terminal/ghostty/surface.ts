import { SurfaceKeyboardController } from "./surfaceKeyboard";
import { SurfacePointerController } from "./surfacePointer";
import type { GhosttySelectionPosition, GhosttyTerminalSurfaceOptions } from "./surfaceTypes";

import {
  GhosttyTerminalCore,
  type GhosttyScrollbar,
  type GhosttySnapshot,
  type GhosttyTheme,
} from "./core";
import {
  measureGhosttyCell,
  renderGhosttySnapshot,
  terminalGridSize,
  type GhosttyCellMetrics,
} from "./renderer";
import { terminalLatencyCallbacks, type TerminalLatencyCallbacks } from "../latency";
import {
  type GhosttyTerminalFont,
  terminalFontSize,
  ensureTerminalSymbolsFont,
  loadTerminalFontFamily,
  terminalFontFamily,
} from "./surfaceFont";
import {
  CONTENT_PADDING,
  terminalScrollbarGeometry,
  terminalScrollbarOffsetAtPointer,
  terminalContentOriginY,
} from "./surfaceGeometry";

/** Half a blink cycle: the visible and hidden phases are equally long. */
const CURSOR_BLINK_INTERVAL_MS = 500;

/**
 * Whether the cursor should keep toggling. An unfocused surface draws a steady
 * hollow cursor instead of blinking, and a reduced-motion reader gets a steady
 * cursor too rather than a permanently animating element.
 */
export function shouldBlinkTerminalCursor(state: {
  readonly focused: boolean;
  readonly cursorBlinking: boolean;
  readonly cursorVisible: boolean;
  readonly reducedMotion: boolean;
}): boolean {
  return state.focused && state.cursorBlinking && state.cursorVisible && !state.reducedMotion;
}

export class GhosttyTerminalSurface {
  readonly canvas: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  readonly scrollbar: HTMLDivElement;
  cols = 1;
  rows = 1;

  private readonly keyboard: SurfaceKeyboardController;

  pasteFromClipboard(
    readText: () => Promise<string>,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    return this.keyboard.pasteFromClipboard(readText, isCurrent);
  }

  private readonly pointer: SurfacePointerController;

  getSelectionPosition(): GhosttySelectionPosition | null {
    return this.pointer.getSelectionPosition();
  }

  getSelectionEndClientRect(): { readonly right: number; readonly bottom: number } | null {
    return this.pointer.getSelectionEndClientRect();
  }

  clearSelection(): void {
    this.pointer.clearSelection();
  }

  private readonly mount: HTMLElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly core: GhosttyTerminalCore;
  private readonly options: GhosttyTerminalSurfaceOptions;
  private readonly latencyCallbacks: TerminalLatencyCallbacks;
  private visible: boolean;
  private hasSize = false;
  private metrics: GhosttyCellMetrics;
  private fontFamily: string;
  private requestedFontFamily: string | undefined;
  private fontSize: number;
  private fontEpoch = 0;
  private pendingFontEpoch: number | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly scrollbarThumb: HTMLDivElement;
  private snapshot: GhosttySnapshot | null = null;
  private frame = 0;
  private cursorTimer: number | null = null;
  private cursorOn = true;
  private renderedCursorY: number | null = null;
  private forceFullRender = true;
  private scrollbarDirty = true;
  private scrollbarState: GhosttyScrollbar | null = null;
  private scrollbarPointerId: number | null = null;
  private scrollbarPointerOffset = 0;
  private disposed = false;
  private resizeNotifyTimer: number | null = null;
  private originY = CONTENT_PADDING;
  private mountHeight = 0;
  private focused = false;
  private resizeNotified = false;
  private canvasConfigured = false;
  private theme: GhosttyTheme;
  private dprMedia: MediaQueryList | null = null;
  // Read live on every blink decision, and watched so that dropping the
  // preference restarts a blink cycle that has no timer left to notice it.
  private readonly reducedMotionMedia = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  private inputLeft = -1;
  private inputTop = -1;

  private constructor(
    mount: HTMLElement,
    canvas: HTMLCanvasElement,
    input: HTMLTextAreaElement,
    scrollbar: HTMLDivElement,
    scrollbarThumb: HTMLDivElement,
    context: CanvasRenderingContext2D,
    core: GhosttyTerminalCore,
    metrics: GhosttyCellMetrics,
    fontFamily: string,
    options: GhosttyTerminalSurfaceOptions,
  ) {
    const surface = this;
    this.mount = mount;
    this.canvas = canvas;
    this.input = input;
    this.scrollbar = scrollbar;
    this.scrollbarThumb = scrollbarThumb;
    this.context = context;
    this.core = core;
    this.metrics = metrics;
    this.options = options;
    this.latencyCallbacks = terminalLatencyCallbacks(options.latencyProbe);
    this.visible = options.visible ?? true;
    this.theme = options.theme;
    this.fontFamily = fontFamily;
    this.requestedFontFamily = options.font?.family;
    this.fontSize = terminalFontSize(options.font?.size);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.pointer = new SurfacePointerController({
      get canvas() {
        return surface.canvas;
      },
      get cols() {
        return surface.cols;
      },
      get rows() {
        return surface.rows;
      },
      get core() {
        return surface.core;
      },
      get disposed() {
        return surface.disposed;
      },
      get metrics() {
        return surface.metrics;
      },
      get options() {
        return surface.options;
      },
      get originY() {
        return surface.originY;
      },
      get snapshot() {
        return surface.snapshot;
      },
      get forceFullRender() {
        return surface.forceFullRender;
      },
      set forceFullRender(value) {
        surface.forceFullRender = value;
      },
      clearPrimedCopy: () => this.keyboard.clearPrimedCopy(),
      focus: () => this.focus(),
      hasSelection: () => this.hasSelection(),
      requestRender: () => this.requestRender(),
      scrollViewport: (deltaRows) => this.scrollViewport(deltaRows),
    });
    this.keyboard = new SurfaceKeyboardController({
      get input() {
        return surface.input;
      },
      get core() {
        return surface.core;
      },
      get disposed() {
        return surface.disposed;
      },
      get options() {
        return surface.options;
      },
      get latencyCallbacks() {
        return surface.latencyCallbacks;
      },
      hasSelection: () => this.hasSelection(),
      getSelection: () => this.getSelection(),
      clearSelection: () => this.clearSelection(),
      updateLinkModifier: (event) => this.pointer.updateLinkModifier(event),
    });
    this.installEvents();
    this.watchDevicePixelRatio();
    this.reducedMotionMedia?.addEventListener("change", this.onReducedMotionChange);
    document.fonts.addEventListener("loadingdone", this.onFontsLoaded);
    this.resizeObserver.observe(mount);
  }

  static async create(
    mount: HTMLElement,
    options: GhosttyTerminalSurfaceOptions,
  ): Promise<GhosttyTerminalSurface> {
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
    mount.replaceChildren(canvas, input, scrollbar);

    const context = canvas.getContext("2d", { alpha: false });

    if (!context) throw new Error("Canvas 2D is unavailable");
    // An opaque canvas backing store initializes to solid black, and the font
    // and WASM loads below leave it on screen for the whole setup window; paint
    // the theme background first so the mount never flashes a black box.
    context.fillStyle = `rgb(${options.theme.background.r}, ${options.theme.background.g}, ${options.theme.background.b})`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const fontSize = terminalFontSize(options.font?.size);

    try {
      // Cell metrics must come from the faces that will render; measuring before
      // the bundled webfonts load would size the grid from a fallback font.
      await ensureTerminalSymbolsFont();
    } catch {
      // Metrics fall back to whichever faces are already available.
    }

    const fontFamily = await loadTerminalFontFamily(options.font?.family, fontSize);
    const metrics = measureGhosttyCell(context, fontSize, fontFamily);
    const grid = terminalGridSize(mount.clientWidth, mount.clientHeight, metrics, CONTENT_PADDING);

    const core = await GhosttyTerminalCore.create(
      grid.cols,
      grid.rows,
      metrics.width,
      metrics.height,
      options.theme,
      options.onData,
    );

    const surface = new GhosttyTerminalSurface(
      mount,
      canvas,
      input,
      scrollbar,
      scrollbarThumb,
      context,
      core,
      metrics,
      fontFamily,
      options,
    );

    surface.fit();

    return surface;
  }

  /** Pause canvas work without interrupting output parsing or terminal replies. */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.cursorOn = true;
    this.forceFullRender = true;
    this.scrollbarDirty = true;

    if (!visible) {
      this.cancelRender();
      this.pointer.setSelectionAutoscroll(0);

      return;
    }

    this.fit();
  }

  write(data: string): void {
    if (this.disposed) return;
    this.core.write(data);
    this.latencyCallbacks.onByteArrival(data);
    this.pointer.synchronizeMouseTrackingState();
    // Restart the blink cycle from the visible phase so the cursor never sits
    // invisible through a stream of output or a burst of typing echo.
    this.cursorOn = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  resetAndWrite(data: string): void {
    if (this.disposed) return;
    this.pointer.lastMouseMotionData = "";
    this.core.resetAndWrite(data);
    this.pointer.synchronizeMouseTrackingState();
    // A replayed session starts from the visible phase like any other write:
    // reattaching mid-blink must not open on an invisible cursor.
    this.cursorOn = true;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  setTheme(theme: GhosttyTheme): void {
    if (this.disposed) return;
    this.theme = theme;
    this.core.setTheme(theme);
    this.forceFullRender = true;
    this.requestRender();
  }

  async setFont(font: GhosttyTerminalFont): Promise<void> {
    if (this.disposed) return;
    const fontSize = terminalFontSize(font.size);
    // The fields only change together with their metrics after the load, and
    // the epoch lets the newest overlapping call win regardless of load order.
    const epoch = ++this.fontEpoch;
    this.pendingFontEpoch = epoch;
    const fontFamily = await loadTerminalFontFamily(font.family, fontSize);

    if (this.disposed || epoch !== this.fontEpoch) return;
    this.pendingFontEpoch = null;
    this.fontFamily = fontFamily;
    this.requestedFontFamily = font.family;
    this.fontSize = fontSize;
    this.applyFontMetrics();
  }

  private applyFontMetrics(): void {
    this.metrics = measureGhosttyCell(this.context, this.fontSize, this.fontFamily);
    this.core.resize(this.cols, this.rows, this.metrics.width, this.metrics.height);
    // Cached IME textarea coordinates are stale in the new cell geometry.
    this.inputLeft = -1;
    this.inputTop = -1;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.fit();
    this.requestRender();
  }

  private readonly onReducedMotionChange = () => {
    if (this.disposed) return;
    // Nothing else wakes an idle steady cursor: the blink timer only reschedules
    // from a render, and reduced motion is exactly the state that stopped it.
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onFontsLoaded = () => {
    if (this.disposed) return;

    // The explicit load validates every style and applies the newest request.
    // Its own loading events must not revalidate the previously applied face.
    if (this.pendingFontEpoch !== null) return;
    // A face may become available after an earlier fallback measurement. Run
    // the fixed-width guard again before using its newly loaded metrics.
    const fontFamily = terminalFontFamily(this.requestedFontFamily);

    if (fontFamily !== this.fontFamily) {
      this.fontFamily = fontFamily;
      this.applyFontMetrics();

      return;
    }

    // A face that finished loading after the initial measurement changes glyph
    // advances; re-measure and refit so the grid matches what actually renders.
    const metrics = measureGhosttyCell(this.context, this.fontSize, this.fontFamily);

    if (
      metrics.width === this.metrics.width &&
      metrics.height === this.metrics.height &&
      metrics.baseline === this.metrics.baseline
    ) {
      return;
    }

    this.applyFontMetrics();
  };

  fit(): boolean {
    if (this.disposed || !this.visible) return false;
    const width = this.mount.clientWidth;
    const height = this.mount.clientHeight;

    if (width <= 0 || height <= 0) {
      this.hasSize = false;
      this.forceFullRender = true;
      this.cancelRender();

      return false;
    }

    this.hasSize = true;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    let shouldRender = false;

    // The DPR transform must be installed even when the target size happens to
    // equal the canvas default 300x150 backing store, so the first fit always
    // schedules a canvas configuration.
    if (
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight ||
      !this.canvasConfigured
    ) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
      this.canvasConfigured = true;
      this.forceFullRender = true;
      this.scrollbarDirty = true;
      shouldRender = true;
    }

    const grid = terminalGridSize(width, height, this.metrics, CONTENT_PADDING);
    this.mountHeight = height;

    // onResize is the only PTY resize channel, so the first successful fit must
    // notify even when the measured grid equals the 1x1 construction sentinel.
    if (grid.cols !== this.cols || grid.rows !== this.rows || !this.resizeNotified) {
      this.cols = grid.cols;
      this.rows = grid.rows;
      this.core.resize(grid.cols, grid.rows, this.metrics.width, this.metrics.height);
      this.notifyResize();
      this.forceFullRender = true;
      this.scrollbarDirty = true;
      shouldRender = true;
    }

    // Rendering synchronously keeps the repaint inside the same frame as the
    // layout change: ResizeObserver fires before paint, so the browser never
    // composites the old backing store stretched into the new element box.
    if (shouldRender || this.forceFullRender) this.renderFrame();

    return true;
  }

  /**
   * The local grid reflows immediately, but the PTY only hears about settled
   * dimensions: notifying on every drag step makes the shell reprint its
   * prompt mid-drag, which reads as jitter.
   */
  private notifyResize(): void {
    this.resizeNotified = true;

    if (this.resizeNotifyTimer !== null) window.clearTimeout(this.resizeNotifyTimer);
    this.resizeNotifyTimer = window.setTimeout(() => {
      this.resizeNotifyTimer = null;

      if (!this.disposed) this.options.onResize(this.cols, this.rows);
    }, 150);
  }

  focus(): void {
    if (this.disposed || !this.visible) return;
    this.input.focus({ preventScroll: true });
  }

  hasSelection(): boolean {
    return this.core.selectionText().length > 0;
  }

  getSelection(): string {
    return this.core.selectionText();
  }

  scrollToBottom(): void {
    this.core.scrollToBottom();
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  isAtBottom(): boolean {
    return this.core.isViewportActive();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    document.fonts.removeEventListener("loadingdone", this.onFontsLoaded);
    this.dprMedia?.removeEventListener("change", this.onDevicePixelRatioChange);
    this.dprMedia = null;
    this.reducedMotionMedia?.removeEventListener("change", this.onReducedMotionChange);

    if (this.pointer.selectionScrollTimer !== null)
      window.clearInterval(this.pointer.selectionScrollTimer);

    if (this.resizeNotifyTimer !== null) {
      window.clearTimeout(this.resizeNotifyTimer);
      this.resizeNotifyTimer = null;
      // Flush the settled dimensions so the PTY keeps the final size even when
      // the surface unmounts inside the debounce window.
      this.options.onResize(this.cols, this.rows);
    }

    this.cancelRender();

    if (this.keyboard.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.keyboard.compositionSuppressionTimer);
    }

    this.removeEvents();
    this.core.dispose();

    if (
      this.canvas.parentElement === this.mount ||
      this.input.parentElement === this.mount ||
      this.scrollbar.parentElement === this.mount
    ) {
      this.canvas.remove();
      this.input.remove();
      this.scrollbar.remove();
    }
  }

  private readonly onFocus = () => {
    this.focused = true;
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onBlur = () => {
    this.focused = false;
    this.pointer.linkModifierActive = false;
    this.pointer.refreshHoveredLink();
    // Suppressions survive blur deliberately: a shortcut that moves focus (for
    // example terminal-toggle) must still swallow its own keyup if focus comes
    // back before release. Stale entries are harmless — an encoding keydown
    // always removes its code first.
    // The steady unfocused hollow cursor must not inherit an off blink phase.
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onDevicePixelRatioChange = () => {
    this.watchDevicePixelRatio();
    this.fit();
  };

  private watchDevicePixelRatio(): void {
    this.dprMedia?.removeEventListener("change", this.onDevicePixelRatioChange);
    // A resolution media query only fires once for the ratio it was created at,
    // so re-arm it after every change (monitor moves, browser zoom).
    this.dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprMedia.addEventListener("change", this.onDevicePixelRatioChange);
  }

  private readonly onScrollbarPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const state = this.readScrollbarState();

    if (state === null) return;
    const bounds = this.scrollbar.getBoundingClientRect();
    const geometry = terminalScrollbarGeometry(state, bounds.height);

    if (geometry === null) return;
    event.preventDefault();
    event.stopPropagation();
    this.scrollbarPointerId = event.pointerId;
    this.scrollbarPointerOffset =
      event.target === this.scrollbarThumb
        ? event.clientY - bounds.top - geometry.thumbTop
        : geometry.thumbHeight / 2;
    this.scrollbar.setPointerCapture(event.pointerId);
    this.scrollbarToPointer(event.clientY, bounds);
  };

  private readonly onScrollbarPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.scrollbarPointerId || this.scrollbarState === null) return;
    event.preventDefault();
    this.scrollbarToPointer(event.clientY, this.scrollbar.getBoundingClientRect());
  };

  private readonly onScrollbarPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.scrollbarPointerId) return;
    event.preventDefault();
    this.scrollbarPointerId = null;

    if (this.scrollbar.hasPointerCapture(event.pointerId)) {
      this.scrollbar.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onScrollbarKeyDown = (event: KeyboardEvent) => {
    const state = this.readScrollbarState();

    if (state === null) return;
    let delta = 0;

    switch (event.key) {
      case "ArrowUp":
        delta = -1;
        break;
      case "ArrowDown":
        delta = 1;
        break;
      case "PageUp":
        delta = -Math.max(1, state.len);
        break;
      case "PageDown":
        delta = Math.max(1, state.len);
        break;
      case "Home":
        delta = -state.offset;
        break;
      case "End":
        delta = state.total - state.len - state.offset;
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.scrollViewport(delta);
  };

  private installEvents(): void {
    this.input.addEventListener("keydown", this.keyboard.onKeyDown);
    this.input.addEventListener("keyup", this.keyboard.onKeyUp);
    this.input.addEventListener("focus", this.onFocus);
    this.input.addEventListener("blur", this.onBlur);
    this.input.addEventListener("input", this.keyboard.onInput);
    this.input.addEventListener("paste", this.keyboard.onPaste);
    this.input.addEventListener("copy", this.keyboard.onCopyEvent);
    this.input.addEventListener("compositionstart", this.keyboard.onCompositionStart);
    this.input.addEventListener("compositionend", this.keyboard.onCompositionEnd);
    this.canvas.addEventListener("pointerdown", this.pointer.onPointerDown);
    this.canvas.addEventListener("pointermove", this.pointer.onPointerMove);
    this.canvas.addEventListener("pointerleave", this.pointer.onPointerLeave);
    this.canvas.addEventListener("pointerup", this.pointer.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.pointer.onPointerUp);
    this.canvas.addEventListener("wheel", this.pointer.onWheel, { passive: false });
    this.canvas.addEventListener("mousedown", this.pointer.onMouseDown);
    this.canvas.addEventListener("contextmenu", this.pointer.onContextMenu);
    this.scrollbar.addEventListener("pointerdown", this.onScrollbarPointerDown);
    this.scrollbar.addEventListener("pointermove", this.onScrollbarPointerMove);
    this.scrollbar.addEventListener("pointerup", this.onScrollbarPointerUp);
    this.scrollbar.addEventListener("pointercancel", this.onScrollbarPointerUp);
    this.scrollbar.addEventListener("keydown", this.onScrollbarKeyDown);
  }

  private removeEvents(): void {
    this.input.removeEventListener("keydown", this.keyboard.onKeyDown);
    this.input.removeEventListener("keyup", this.keyboard.onKeyUp);
    this.input.removeEventListener("focus", this.onFocus);
    this.input.removeEventListener("blur", this.onBlur);
    this.input.removeEventListener("input", this.keyboard.onInput);
    this.input.removeEventListener("paste", this.keyboard.onPaste);
    this.input.removeEventListener("copy", this.keyboard.onCopyEvent);
    this.input.removeEventListener("compositionstart", this.keyboard.onCompositionStart);
    this.input.removeEventListener("compositionend", this.keyboard.onCompositionEnd);
    this.canvas.removeEventListener("pointerdown", this.pointer.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.pointer.onPointerMove);
    this.canvas.removeEventListener("pointerleave", this.pointer.onPointerLeave);
    this.canvas.removeEventListener("pointerup", this.pointer.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.pointer.onPointerUp);
    this.canvas.removeEventListener("wheel", this.pointer.onWheel);
    this.canvas.removeEventListener("mousedown", this.pointer.onMouseDown);
    this.canvas.removeEventListener("contextmenu", this.pointer.onContextMenu);
    this.scrollbar.removeEventListener("pointerdown", this.onScrollbarPointerDown);
    this.scrollbar.removeEventListener("pointermove", this.onScrollbarPointerMove);
    this.scrollbar.removeEventListener("pointerup", this.onScrollbarPointerUp);
    this.scrollbar.removeEventListener("pointercancel", this.onScrollbarPointerUp);
    this.scrollbar.removeEventListener("keydown", this.onScrollbarKeyDown);
  }

  private scrollViewport(deltaRows: number): void {
    let delta = Math.trunc(deltaRows);
    const state = this.readScrollbarState();

    if (state !== null) {
      const maxOffset = Math.max(0, state.total - state.len);
      const offset = Math.max(0, Math.min(state.offset + delta, maxOffset));
      delta = offset - state.offset;
      this.scrollbarState = { ...state, offset };
    }

    if (delta === 0) return;
    this.core.scroll(delta);
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  private scrollbarToPointer(clientY: number, bounds: DOMRect): void {
    const state = this.scrollbarState;

    if (state === null) return;

    const offset = terminalScrollbarOffsetAtPointer(
      state,
      bounds.height,
      clientY - bounds.top,
      this.scrollbarPointerOffset,
    );

    this.scrollViewport(offset - state.offset);
  }

  private updateScrollbar(): void {
    const state = this.readScrollbarState();

    const geometry =
      state === null
        ? null
        : terminalScrollbarGeometry(
            state,
            Math.max(0, this.mount.clientHeight - CONTENT_PADDING * 2),
          );

    this.scrollbar.hidden = geometry === null;

    if (state === null || geometry === null) return;
    this.scrollbar.setAttribute("aria-valuemin", "0");
    this.scrollbar.setAttribute("aria-valuemax", String(geometry.maxOffset));
    this.scrollbar.setAttribute(
      "aria-valuenow",
      String(Math.max(0, Math.min(state.offset, geometry.maxOffset))),
    );
    this.scrollbarThumb.style.height = `${geometry.thumbHeight}px`;
    this.scrollbarThumb.style.transform = `translateY(${geometry.thumbTop}px)`;
  }

  private readScrollbarState(): GhosttyScrollbar | null {
    const state = this.core.scrollbarState();
    this.scrollbarState = state;

    return state;
  }

  private requestRender(): void {
    if (this.disposed || !this.visible || !this.hasSize || this.frame !== 0) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.renderFrame();
    });
  }

  private cancelRender(): void {
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }

    if (this.cursorTimer !== null) {
      window.clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
    }
  }

  private renderFrame(): void {
    if (this.disposed || !this.visible) return;

    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }

    // Hidden thread drawers stay mounted so switching back is instant, but a
    // display:none canvas has nothing to show. Ghostty keeps parsing; the
    // ResizeObserver refits and repaints in full once the mount has a size.
    if (this.mount.clientWidth === 0 || this.mount.clientHeight === 0) {
      this.hasSize = false;
      this.forceFullRender = true;
      this.cancelRender();

      return;
    }

    this.snapshot = this.core.snapshot();

    // A cursor that is not blinking right now must be drawn, never caught in an
    // off phase left behind by a blink that has since been turned off.
    if (!this.blinkEnabled()) this.cursorOn = true;
    // The origin only moves together with a forced full repaint: partial
    // dirty-row redraws must never composite rows at a shifted origin over
    // rows painted at the previous one. Bottom anchoring starts once
    // scrollback exists, i.e. when the prompt actually lives at the bottom.
    const scrollState = this.readScrollbarState();
    const anchorBottom = scrollState !== null && scrollState.total > scrollState.len;

    const nextOriginY = terminalContentOriginY(
      this.mountHeight,
      CONTENT_PADDING,
      this.rows,
      this.metrics.height,
      anchorBottom,
    );

    if (nextOriginY !== this.originY) {
      this.originY = nextOriginY;
      this.forceFullRender = true;
    }

    this.pointer.refreshHoveredLink();
    renderGhosttySnapshot({
      context: this.context,
      snapshot: this.snapshot,
      metrics: this.metrics,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      padding: CONTENT_PADDING,
      originY: this.originY,
      forceFull: this.forceFullRender,
      cursorOn: this.cursorOn,
      previousCursorY: this.renderedCursorY,
      focused: this.focused,
      hoveredLinkRange: this.pointer.hoveredLink?.range ?? null,
      ...(this.theme.selectionBackground !== undefined
        ? { selectionBackground: this.theme.selectionBackground }
        : {}),
    });
    this.latencyCallbacks.onGlyphPaint(this.snapshot, this.forceFullRender);
    this.positionInput();
    this.renderedCursorY =
      this.cursorOn && this.snapshot.cursorVisible && this.snapshot.cursorY >= 0
        ? this.snapshot.cursorY
        : null;

    if (this.scrollbarDirty) {
      this.scrollbarDirty = false;
      this.updateScrollbar();
    }

    this.forceFullRender = false;
    this.scheduleCursorBlink();
  }

  private scheduleCursorBlink(): void {
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
    this.cursorTimer = null;

    if (!this.blinkEnabled()) return;
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null;
      this.cursorOn = !this.cursorOn;
      this.requestRender();
    }, CURSOR_BLINK_INTERVAL_MS);
  }

  private blinkEnabled(): boolean {
    const snapshot = this.snapshot;

    if (!snapshot || !this.visible || !this.hasSize) return false;

    return shouldBlinkTerminalCursor({
      focused: this.focused,
      cursorBlinking: snapshot.cursorBlinking,
      cursorVisible: snapshot.cursorVisible,
      reducedMotion: this.reducedMotionMedia?.matches ?? false,
    });
  }

  private positionInput(): void {
    const snapshot = this.snapshot;

    if (!snapshot || !snapshot.cursorVisible || snapshot.cursorX < 0 || snapshot.cursorY < 0) {
      return;
    }

    // The IME candidate window anchors to the textarea, so it must follow the
    // terminal cursor for composition to appear where the user is typing.
    const left = CONTENT_PADDING + snapshot.cursorX * this.metrics.width;
    const top = this.originY + snapshot.cursorY * this.metrics.height;

    if (left === this.inputLeft && top === this.inputTop) return;
    this.inputLeft = left;
    this.inputTop = top;
    this.input.style.left = `${left}px`;
    this.input.style.top = `${top}px`;
    this.input.style.height = `${this.metrics.height}px`;
  }
}

export {
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_TERMINAL_FONT_FAMILY,
  type GhosttyTerminalFont,
  terminalFontFamily,
  loadTerminalFontFamily,
  terminalFontSize,
} from "./surfaceFont";

export {
  terminalContentOriginY,
  type TerminalScrollbarGeometry,
  terminalScrollbarGeometry,
  terminalScrollbarOffsetAtPointer,
  terminalGridCellAt,
  terminalLinkAtPosition,
  type TerminalLinkWithRange,
  terminalLinkAtPositionWithRange,
  terminalLinkAtColumn,
} from "./surfaceGeometry";

export {
  isTerminalCopyShortcut,
  primeTerminalCopyInput,
  clearPrimedTerminalCopyInput,
  applyTerminalCopyEvent,
  isTerminalPasteShortcut,
  isTerminalCompositionCommitInput,
  isTerminalCompositionKey,
  isTerminalAltGraphText,
  shouldReportTerminalMouse,
  resolveTerminalMouseData,
  resolveTerminalMouseTrackingState,
  terminalWheelDeltaRows,
  terminalWheelArrowData,
  isTerminalLinkPointerGesture,
  ghosttyMouseButton,
  type TerminalSelectionClickSequence,
  advanceTerminalSelectionClickSequence,
} from "./surfaceInput";

export type { GhosttySelectionPosition, GhosttyTerminalSurfaceOptions } from "./surfaceTypes";
