import { SurfaceKeyboardController } from "./surfaceKeyboard";
import { SurfacePointerController } from "./surfacePointer";
import { SurfaceScrollbarController } from "./surfaceScrollbar";
import { mountGhosttySurfaceElements } from "./surfaceElements";
import type { GhosttySelectionPosition, GhosttyTerminalSurfaceOptions } from "./surfaceTypes";

import { GhosttyTerminalCore, type GhosttySnapshot, type GhosttyTheme } from "./core";
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
} from "./surfaceFont";
import { SurfaceFontController } from "./surfaceFontState";
import { CONTENT_PADDING, terminalContentOriginY } from "./surfaceGeometry";

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

  private readonly scrollbarController: SurfaceScrollbarController;

  private readonly mount: HTMLElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly core: GhosttyTerminalCore;
  private readonly options: GhosttyTerminalSurfaceOptions;
  private readonly latencyCallbacks: TerminalLatencyCallbacks;
  private visible: boolean;
  private hasSize = false;
  private metrics: GhosttyCellMetrics;
  private readonly font: SurfaceFontController;
  private readonly resizeObserver: ResizeObserver;
  private snapshot: GhosttySnapshot | null = null;
  private frame = 0;
  private cursorTimer: number | null = null;
  private cursorOn = true;
  private renderedCursorY: number | null = null;
  private forceFullRender = true;
  private scrollbarDirty = true;
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
    this.mount = mount;
    this.canvas = canvas;
    this.input = input;
    this.scrollbar = scrollbar;
    this.context = context;
    this.core = core;
    this.metrics = metrics;
    this.options = options;
    this.latencyCallbacks = terminalLatencyCallbacks(options.latencyProbe);
    this.visible = options.visible ?? true;
    this.theme = options.theme;
    this.font = GhosttyTerminalSurface.createFont(this, fontFamily);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.scrollbarController = GhosttyTerminalSurface.createScrollbar(this, scrollbarThumb);
    this.pointer = GhosttyTerminalSurface.createPointer(this);
    this.keyboard = GhosttyTerminalSurface.createKeyboard(this);
    this.installEvents();
    this.watchDevicePixelRatio();
    this.reducedMotionMedia?.addEventListener("change", this.onReducedMotionChange);
    document.fonts.addEventListener("loadingdone", this.font.onFontsLoaded);
    this.resizeObserver.observe(mount);
  }

  // Controller hosts read the surface live through getters, whose own `this` is the host object.
  private static createPointer(surface: GhosttyTerminalSurface): SurfacePointerController {
    return new SurfacePointerController({
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
      clearPrimedCopy: () => surface.keyboard.clearPrimedCopy(),
      focus: () => surface.focus(),
      hasSelection: () => surface.hasSelection(),
      requestRender: () => surface.requestRender(),
      scrollViewport: (deltaRows) => surface.scrollbarController.scrollViewport(deltaRows),
    });
  }

  private static createFont(
    surface: GhosttyTerminalSurface,
    fontFamily: string,
  ): SurfaceFontController {
    return new SurfaceFontController(
      {
        get context() {
          return surface.context;
        },
        get disposed() {
          return surface.disposed;
        },
        get metrics() {
          return surface.metrics;
        },
        applyFontMetrics: () => surface.applyFontMetrics(),
      },
      fontFamily,
      surface.options.font,
    );
  }

  private static createScrollbar(
    surface: GhosttyTerminalSurface,
    scrollbarThumb: HTMLDivElement,
  ): SurfaceScrollbarController {
    return new SurfaceScrollbarController(
      {
        get core() {
          return surface.core;
        },
        get mount() {
          return surface.mount;
        },
        onViewportScrolled: () => {
          surface.forceFullRender = true;
          surface.scrollbarDirty = true;
          surface.requestRender();
        },
      },
      surface.scrollbar,
      scrollbarThumb,
    );
  }

  private static createKeyboard(surface: GhosttyTerminalSurface): SurfaceKeyboardController {
    return new SurfaceKeyboardController({
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
      hasSelection: () => surface.hasSelection(),
      getSelection: () => surface.getSelection(),
      clearSelection: () => surface.clearSelection(),
      updateLinkModifier: (event) => surface.pointer.updateLinkModifier(event),
    });
  }

  static async create(
    mount: HTMLElement,
    options: GhosttyTerminalSurfaceOptions,
  ): Promise<GhosttyTerminalSurface> {
    const { canvas, input, scrollbar, scrollbarThumb, context } = mountGhosttySurfaceElements(
      mount,
      options.theme,
    );

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

  setFont(font: GhosttyTerminalFont): Promise<void> {
    return this.font.setFont(font);
  }

  private applyFontMetrics(): void {
    this.metrics = this.font.measure();
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
    document.fonts.removeEventListener("loadingdone", this.font.onFontsLoaded);
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
    this.scrollbar.addEventListener("pointerdown", this.scrollbarController.onPointerDown);
    this.scrollbar.addEventListener("pointermove", this.scrollbarController.onPointerMove);
    this.scrollbar.addEventListener("pointerup", this.scrollbarController.onPointerUp);
    this.scrollbar.addEventListener("pointercancel", this.scrollbarController.onPointerUp);
    this.scrollbar.addEventListener("keydown", this.scrollbarController.onKeyDown);
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
    this.scrollbar.removeEventListener("pointerdown", this.scrollbarController.onPointerDown);
    this.scrollbar.removeEventListener("pointermove", this.scrollbarController.onPointerMove);
    this.scrollbar.removeEventListener("pointerup", this.scrollbarController.onPointerUp);
    this.scrollbar.removeEventListener("pointercancel", this.scrollbarController.onPointerUp);
    this.scrollbar.removeEventListener("keydown", this.scrollbarController.onKeyDown);
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
    const scrollState = this.scrollbarController.readState();
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
      fontSize: this.font.fontSize,
      fontFamily: this.font.fontFamily,
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
      this.scrollbarController.update();
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

export type { GhosttySelectionPosition, GhosttyTerminalSurfaceOptions } from "./surfaceTypes";
