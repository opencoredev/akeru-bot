import { GhosttyTerminalCore, type GhosttySnapshot } from "./core";
import { type GhosttyCellMetrics } from "./renderer";

import {
  CONTENT_PADDING,
  type TerminalLinkWithRange,
  terminalGridCellAt,
  terminalLinkAtPositionWithRange,
} from "./surfaceGeometry";
import {
  type TerminalSelectionClickSequence,
  shouldReportTerminalMouse,
  ghosttyMouseButton,
  isTerminalLinkPointerGesture,
  advanceTerminalSelectionClickSequence,
  terminalWheelDeltaRows,
  terminalWheelArrowData,
  type TerminalMouseAction,
  resolveTerminalMouseData,
  resolveTerminalMouseTrackingState,
} from "./surfaceInput";
import type { GhosttySelectionPosition, GhosttyTerminalSurfaceOptions } from "./surfaceTypes";

interface SurfacePointerHost {
  readonly canvas: HTMLCanvasElement;
  readonly cols: number;
  readonly rows: number;
  readonly core: GhosttyTerminalCore;
  readonly disposed: boolean;
  readonly metrics: GhosttyCellMetrics;
  readonly options: GhosttyTerminalSurfaceOptions;
  readonly originY: number;
  readonly snapshot: GhosttySnapshot | null;
  forceFullRender: boolean;
  clearPrimedCopy(): void;
  focus(): void;
  hasSelection(): boolean;
  requestRender(): void;
  scrollViewport(deltaRows: number): void;
}

export class SurfacePointerController {
  constructor(private readonly host: SurfacePointerHost) {
    this.mouseAnyEventTracking = host.core.isMouseAnyEventTracking();
  }

  private selectionEnd: { x: number; y: number } | null = null;

  private selectionAnchorScreen: { x: number; y: number } | null = null;

  private selectionEndScreen: { x: number; y: number } | null = null;

  private selectionMode: "cell" | "word" | "line" = "cell";

  // Word/line selection base in screen coordinates so streaming output cannot
  // shift the origin of a drag selection.
  private selectionBase: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null = null;

  selectionScrollTimer: number | null = null;

  private selectionScrollDelta = 0;

  private selectionPointer: { x: number; y: number } | null = null;

  private mouseReportingPointerId: number | null = null;

  private mouseReportingButton: number | null = null;

  private linkActivationPointerId: number | null = null;

  hoveredLink: TerminalLinkWithRange | null = null;

  private hoverPointer: { x: number; y: number } | null = null;

  linkModifierActive = false;

  private selectionClickSequence: TerminalSelectionClickSequence | null = null;

  private selectionMoved = false;

  private wheelRemainder = 0;

  lastMouseMotionData = "";

  private mouseAnyEventTracking = false;

  getSelectionPosition(): GhosttySelectionPosition | null {
    if (!this.selectionAnchorScreen || !this.selectionEndScreen || !this.host.hasSelection())
      return null;

    const before =
      this.selectionAnchorScreen.y < this.selectionEndScreen.y ||
      (this.selectionAnchorScreen.y === this.selectionEndScreen.y &&
        this.selectionAnchorScreen.x <= this.selectionEndScreen.x);

    return before
      ? { start: this.selectionAnchorScreen, end: this.selectionEndScreen }
      : { start: this.selectionEndScreen, end: this.selectionAnchorScreen };
  }

  getSelectionEndClientRect(): { readonly right: number; readonly bottom: number } | null {
    const position = this.getSelectionPosition();

    if (!position) return null;
    const viewportEnd = this.host.core.screenPointToViewport(position.end.x, position.end.y);

    if (!viewportEnd) return null;
    const bounds = this.host.canvas.getBoundingClientRect();

    return {
      right: bounds.left + CONTENT_PADDING + (viewportEnd.x + 1) * this.host.metrics.width,
      bottom: bounds.top + this.host.originY + (viewportEnd.y + 1) * this.host.metrics.height,
    };
  }

  clearSelection(): void {
    this.host.clearPrimedCopy();
    this.host.core.clearSelection();
    this.selectionEnd = null;
    this.selectionAnchorScreen = null;
    this.selectionEndScreen = null;
    this.selectionMode = "cell";
    this.selectionBase = null;
    this.setSelectionAutoscroll(0);
    this.host.options.onSelectionChange();
    // Selection highlights span rows Ghostty may not mark dirty for this change.
    this.host.forceFullRender = true;
    this.host.requestRender();
  }

  readonly onPointerDown = (event: PointerEvent) => {
    this.host.focus();

    if (shouldReportTerminalMouse(this.host.core.isMouseTracking(), event)) {
      const button = ghosttyMouseButton(event.button);

      if (button === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.clearHoveredLink("default");
      this.mouseReportingPointerId = event.pointerId;
      this.mouseReportingButton = button;
      this.sendMouse("press", button, event);
      this.host.canvas.setPointerCapture(event.pointerId);

      return;
    }

    if (event.button !== 0) return;

    if (isTerminalLinkPointerGesture(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.linkActivationPointerId = event.pointerId;
      this.host.canvas.setPointerCapture(event.pointerId);

      return;
    }

    this.clearHoveredLink();
    const cell = this.cellAt(event.clientX, event.clientY);
    this.selectionMoved = false;
    this.selectionClickSequence = advanceTerminalSelectionClickSequence(
      this.selectionClickSequence,
      event,
    );
    const clickCount = this.selectionClickSequence.count;
    this.selectionMode = clickCount >= 3 ? "line" : clickCount === 2 ? "word" : "cell";

    const range =
      this.selectionMode === "line"
        ? this.host.core.selectLine(cell.x, cell.y)
        : this.selectionMode === "word"
          ? this.host.core.selectWord(cell.x, cell.y)
          : null;

    if (range) {
      this.selectionBase = range.screen;
      this.selectionEnd = range.viewport.end;
      this.selectionAnchorScreen = range.screen.start;
      this.selectionEndScreen = range.screen.end;
      this.host.options.onSelectionChange();
    } else {
      this.selectionMode = "cell";
      this.selectionBase = null;
      this.selectionEnd = cell;
      const screen = this.host.core.viewportPointToScreen(cell.x, cell.y);
      this.selectionAnchorScreen = screen;
      this.selectionEndScreen = screen;

      if (screen) {
        this.host.core.setSelection({ ...screen, tag: 2 }, { ...screen, tag: 2 });
      } else {
        this.host.core.setSelection(cell, cell);
      }
    }

    this.host.forceFullRender = true;
    this.host.canvas.setPointerCapture(event.pointerId);
    this.host.requestRender();
  };

  readonly onPointerMove = (event: PointerEvent) => {
    if (this.linkActivationPointerId === event.pointerId) return;
    // Hover motion is only reportable in any-event tracking (DEC 1003); normal and
    // button-event tracking never report motion without a captured pressed button.
    const anyEventTracking = this.synchronizeMouseTrackingState();

    if (
      this.mouseReportingPointerId === event.pointerId ||
      shouldReportTerminalMouse(anyEventTracking, event)
    ) {
      event.preventDefault();
      this.hoverPointer = { x: event.clientX, y: event.clientY };
      this.linkModifierActive = isTerminalLinkPointerGesture(event);
      // A drag whose press was already sent to the terminal application cannot
      // turn into link activation midway through, so link feedback would lie.
      this.setHoveredLink(null);
      this.host.canvas.style.cursor = "default";
      this.sendMouse("motion", this.buttonFromButtons(event.buttons), event);

      return;
    }

    this.lastMouseMotionData = "";

    if (!this.selectionAnchorScreen || !this.host.canvas.hasPointerCapture(event.pointerId)) {
      this.updateHoverCursor(event);

      return;
    }

    this.clearHoveredLink();
    this.selectionPointer = { x: event.clientX, y: event.clientY };
    const bounds = this.host.canvas.getBoundingClientRect();
    this.setSelectionAutoscroll(
      event.clientY < bounds.top ? -1 : event.clientY > bounds.bottom ? 1 : 0,
    );
    const cell = this.cellAt(event.clientX, event.clientY);

    if (cell.x === this.selectionEnd?.x && cell.y === this.selectionEnd.y) return;
    this.extendSelectionTo(event.clientX, event.clientY);
  };

  private extendSelectionTo(clientX: number, clientY: number): void {
    const anchorScreen = this.selectionAnchorScreen;

    if (anchorScreen === null) return;
    const cell = this.cellAt(clientX, clientY);
    this.selectionMoved = true;
    this.selectionEnd = cell;

    const range =
      this.selectionMode === "line"
        ? this.host.core.selectLine(cell.x, cell.y)
        : this.selectionMode === "word"
          ? this.host.core.selectWord(cell.x, cell.y)
          : null;

    const cellScreen = this.host.core.viewportPointToScreen(cell.x, cell.y);

    if (cellScreen === null) return;
    const base = this.selectionBase;

    const beforeBase =
      base !== null &&
      (cellScreen.y < base.start.y ||
        (cellScreen.y === base.start.y && cellScreen.x < base.start.x));

    const anchor = base === null ? anchorScreen : beforeBase ? base.end : base.start;
    const end = range === null ? cellScreen : beforeBase ? range.screen.start : range.screen.end;
    this.selectionAnchorScreen = anchor;
    this.selectionEndScreen = end;
    this.host.core.setSelection({ ...anchor, tag: 2 }, { ...end, tag: 2 });
    this.host.options.onSelectionChange();
    this.host.forceFullRender = true;
    this.host.requestRender();
  }

  setSelectionAutoscroll(delta: number): void {
    this.selectionScrollDelta = delta;

    if (delta === 0) {
      if (this.selectionScrollTimer !== null) {
        window.clearInterval(this.selectionScrollTimer);
        this.selectionScrollTimer = null;
      }

      return;
    }

    if (this.selectionScrollTimer !== null) return;
    // Dragging past the edge scrolls the viewport and keeps extending the
    // selection into the newly revealed rows, like xterm's drag scroller.
    this.selectionScrollTimer = window.setInterval(() => {
      if (this.host.disposed || this.selectionScrollDelta === 0) return;
      this.host.scrollViewport(this.selectionScrollDelta);
      const pointer = this.selectionPointer;

      if (pointer) this.extendSelectionTo(pointer.x, pointer.y);
    }, 80);
  }

  private updateHoverCursor(event: PointerEvent): void {
    this.hoverPointer = { x: event.clientX, y: event.clientY };
    this.linkModifierActive = isTerminalLinkPointerGesture(event);
    this.refreshHoveredLink();
  }

  updateLinkModifier(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">): void {
    const active = isTerminalLinkPointerGesture(event);

    if (active === this.linkModifierActive) return;
    this.linkModifierActive = active;
    this.refreshHoveredLink();
  }

  readonly onPointerLeave = () => {
    this.lastMouseMotionData = "";
    this.clearHoveredLink();
  };

  private clearHoveredLink(cursor = ""): void {
    this.hoverPointer = null;
    this.setHoveredLink(null);
    this.host.canvas.style.cursor = cursor;
  }

  refreshHoveredLink(): void {
    const pointer = this.hoverPointer;
    const link = pointer && this.linkModifierActive ? this.linkAt(pointer.x, pointer.y) : null;
    this.setHoveredLink(link);
  }

  private setHoveredLink(link: TerminalLinkWithRange | null): void {
    const previous = this.hoveredLink;

    const unchanged =
      previous?.text === link?.text &&
      previous?.range.start.x === link?.range.start.x &&
      previous?.range.start.y === link?.range.start.y &&
      previous?.range.end.x === link?.range.end.x &&
      previous?.range.end.y === link?.range.end.y;

    this.host.canvas.style.cursor = link ? "pointer" : "";

    if (unchanged) return;
    this.hoveredLink = link;
    this.host.forceFullRender = true;
    this.host.requestRender();
  }

  readonly onPointerUp = (event: PointerEvent) => {
    this.setSelectionAutoscroll(0);

    if (this.linkActivationPointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.linkActivationPointerId = null;

      if (this.host.canvas.hasPointerCapture(event.pointerId)) {
        this.host.canvas.releasePointerCapture(event.pointerId);
      }

      if (event.type !== "pointercancel") {
        const link = this.linkAt(event.clientX, event.clientY);

        if (link) this.host.options.onLinkActivate(link.text, event);
      }

      return;
    }

    if (this.mouseReportingPointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.sendMouse("release", this.mouseReportingButton, event);
      this.mouseReportingPointerId = null;
      this.mouseReportingButton = null;

      if (this.host.canvas.hasPointerCapture(event.pointerId)) {
        this.host.canvas.releasePointerCapture(event.pointerId);
      }

      if (event.type === "pointercancel") {
        this.clearHoveredLink();
      } else {
        this.hoverPointer = { x: event.clientX, y: event.clientY };
        this.linkModifierActive = isTerminalLinkPointerGesture(event);
        this.refreshHoveredLink();
      }

      return;
    }

    if (this.host.canvas.hasPointerCapture(event.pointerId)) {
      this.host.canvas.releasePointerCapture(event.pointerId);
    }

    if (event.button !== 0) return;

    if (!this.selectionMoved && this.selectionMode === "cell") {
      this.clearSelection();
    }

    this.host.options.onSelectionChange();
  };

  readonly onWheel = (event: WheelEvent) => {
    if (event.deltaY === 0) return;
    event.preventDefault();

    const delta = terminalWheelDeltaRows(
      event,
      this.host.metrics.height,
      this.host.rows,
      this.wheelRemainder,
    );

    this.wheelRemainder = delta.remainder;

    if (delta.rows === 0) return;
    const magnitude = Math.abs(delta.rows);

    if (shouldReportTerminalMouse(this.host.core.isMouseTracking(), event)) {
      const button = delta.rows < 0 ? 4 : 5;

      for (let index = 0; index < magnitude; index += 1) {
        this.sendMouse("press", button, event);
      }

      return;
    }

    if (this.host.core.isAlternateScreen()) {
      // The alternate screen has no scrollback: translate wheel motion into
      // arrow keys so full-screen apps like vim and less scroll, matching xterm.
      this.host.options.onData(
        terminalWheelArrowData(delta.rows, this.host.core.isApplicationCursorKeys()),
      );

      return;
    }

    this.host.scrollViewport(delta.rows);
  };

  readonly onMouseDown = (event: MouseEvent) => {
    if (event.button === 0) event.preventDefault();
    this.host.focus();
  };

  readonly onContextMenu = (event: MouseEvent) => {
    if (shouldReportTerminalMouse(this.host.core.isMouseTracking(), event)) {
      event.preventDefault();

      return;
    }

    this.host.options.onContextMenu?.(event);
  };

  private cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const bounds = this.host.canvas.getBoundingClientRect();

    return {
      x: Math.max(
        0,
        Math.min(
          this.host.cols - 1,
          Math.floor((clientX - bounds.left - CONTENT_PADDING) / this.host.metrics.width),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          this.host.rows - 1,
          Math.floor((clientY - bounds.top - this.host.originY) / this.host.metrics.height),
        ),
      ),
    };
  }

  private linkAt(clientX: number, clientY: number): TerminalLinkWithRange | null {
    if (!this.host.snapshot) return null;

    const cell = terminalGridCellAt({
      bounds: this.host.canvas.getBoundingClientRect(),
      clientX,
      clientY,
      cols: this.host.cols,
      rows: this.host.rows,
      metrics: this.host.metrics,
      padding: CONTENT_PADDING,
      originY: this.host.originY,
    });

    if (!cell) return null;
    const explicitHyperlink = this.host.core.hyperlinkAt(cell.x, cell.y);

    if (explicitHyperlink) {
      const start = { ...cell };
      const end = { ...cell };

      while (true) {
        const previous =
          start.x > 0
            ? { x: start.x - 1, y: start.y }
            : start.y > 0 && this.host.snapshot.rowData[start.y]?.isWrapContinuation
              ? { x: this.host.cols - 1, y: start.y - 1 }
              : null;

        if (!previous || this.host.core.hyperlinkAt(previous.x, previous.y) !== explicitHyperlink)
          break;
        start.x = previous.x;
        start.y = previous.y;
      }

      while (true) {
        const next =
          end.x + 1 < this.host.cols
            ? { x: end.x + 1, y: end.y }
            : end.y + 1 < this.host.rows && this.host.snapshot.rowData[end.y]?.wrapsToNext
              ? { x: 0, y: end.y + 1 }
              : null;

        if (!next || this.host.core.hyperlinkAt(next.x, next.y) !== explicitHyperlink) break;
        end.x = next.x;
        end.y = next.y;
      }

      return {
        text: explicitHyperlink,
        range: { start, end },
      };
    }

    return terminalLinkAtPositionWithRange(this.host.snapshot.rowData, cell.y, cell.x);
  }

  private sendMouse(action: TerminalMouseAction, button: number | null, event: MouseEvent): void {
    const bounds = this.host.canvas.getBoundingClientRect();

    const data = this.host.core.encodeMouse({
      action,
      button,
      mods:
        (event.shiftKey ? 1 : 0) |
        (event.ctrlKey ? 1 << 1 : 0) |
        (event.altKey ? 1 << 2 : 0) |
        (event.metaKey ? 1 << 3 : 0),
      x: Math.max(0, event.clientX - bounds.left),
      y: Math.max(0, event.clientY - bounds.top),
      screenWidth: bounds.width,
      screenHeight: bounds.height,
      cellWidth: this.host.metrics.width,
      cellHeight: this.host.metrics.height,
      paddingLeft: CONTENT_PADDING,
      paddingRight: CONTENT_PADDING,
      paddingTop: this.host.originY,
      paddingBottom: Math.max(
        0,
        bounds.height - this.host.originY - this.host.rows * this.host.metrics.height,
      ),
      anyButtonPressed: event.buttons !== 0,
    });

    const resolution = resolveTerminalMouseData(action, data, this.lastMouseMotionData);
    this.lastMouseMotionData = resolution.nextMotionData;

    if (resolution.send) this.host.options.onData(data);
  }

  synchronizeMouseTrackingState(): boolean {
    // Output writes can toggle DEC 1003 without moving the pointer. Keep the
    // previous mode so the next same-cell motion starts a fresh tracking session.
    const tracking = this.host.core.isMouseAnyEventTracking();

    const state = resolveTerminalMouseTrackingState(
      this.mouseAnyEventTracking,
      tracking,
      this.lastMouseMotionData,
    );

    this.mouseAnyEventTracking = state.tracking;
    this.lastMouseMotionData = state.motionData;

    return tracking;
  }

  private buttonFromButtons(buttons: number): number | null {
    if ((buttons & 1) !== 0) return 1;

    if ((buttons & 4) !== 0) return 3;

    if ((buttons & 2) !== 0) return 2;

    if ((buttons & 8) !== 0) return 4;

    if ((buttons & 16) !== 0) return 5;

    return null;
  }
}
