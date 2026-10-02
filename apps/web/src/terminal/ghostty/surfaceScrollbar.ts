import type { GhosttyScrollbar, GhosttyTerminalCore } from "./core";
import {
  CONTENT_PADDING,
  terminalScrollbarGeometry,
  terminalScrollbarOffsetAtPointer,
} from "./surfaceGeometry";

interface SurfaceScrollbarHost {
  readonly core: Pick<GhosttyTerminalCore, "scroll" | "scrollbarState">;
  readonly mount: Pick<HTMLElement, "clientHeight">;
  /** Runs after the viewport moved so the surface repaints rows and scrollbar. */
  onViewportScrolled(): void;
}

/**
 * Drives the terminal scrollback scrollbar: thumb dragging, keyboard paging,
 * and the viewport scrolling that wheel and selection autoscroll share.
 */
export class SurfaceScrollbarController {
  constructor(
    private readonly host: SurfaceScrollbarHost,
    private readonly scrollbar: HTMLDivElement,
    private readonly scrollbarThumb: HTMLDivElement,
  ) {}

  private scrollbarState: GhosttyScrollbar | null = null;

  private scrollbarPointerId: number | null = null;

  private scrollbarPointerOffset = 0;

  readonly onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const state = this.readState();

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
    this.scrollToPointer(event.clientY, bounds);
  };

  readonly onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.scrollbarPointerId || this.scrollbarState === null) return;
    event.preventDefault();
    this.scrollToPointer(event.clientY, this.scrollbar.getBoundingClientRect());
  };

  readonly onPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.scrollbarPointerId) return;
    event.preventDefault();
    this.scrollbarPointerId = null;

    if (this.scrollbar.hasPointerCapture(event.pointerId)) {
      this.scrollbar.releasePointerCapture(event.pointerId);
    }
  };

  readonly onKeyDown = (event: KeyboardEvent) => {
    const state = this.readState();

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

  scrollViewport(deltaRows: number): void {
    let delta = Math.trunc(deltaRows);
    const state = this.readState();

    if (state !== null) {
      const maxOffset = Math.max(0, state.total - state.len);
      const offset = Math.max(0, Math.min(state.offset + delta, maxOffset));
      delta = offset - state.offset;
      this.scrollbarState = { ...state, offset };
    }

    if (delta === 0) return;
    this.host.core.scroll(delta);
    this.host.onViewportScrolled();
  }

  update(): void {
    const state = this.readState();

    const geometry =
      state === null
        ? null
        : terminalScrollbarGeometry(
            state,
            Math.max(0, this.host.mount.clientHeight - CONTENT_PADDING * 2),
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

  readState(): GhosttyScrollbar | null {
    const state = this.host.core.scrollbarState();
    this.scrollbarState = state;

    return state;
  }

  private scrollToPointer(clientY: number, bounds: DOMRect): void {
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
}
