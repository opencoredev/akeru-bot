import * as Predicate from "effect/Predicate";
import { type GhosttyKeyboardLayoutMap, loadGhosttyKeyboardLayoutMap } from "./keyCodes";
import { GhosttyRuntime, loadGhosttyRuntime } from "./runtime";
import { GhosttyInputEncoder } from "./coreInput";
import { GhosttySnapshotReader } from "./coreSnapshot";
import {
  type GhosttyTheme,
  MAX_SCROLLBACK_ROWS,
  assertGhosttySuccess,
  GHOSTTY_SUCCESS,
  type GhosttyScrollbar,
  GHOSTTY_OUT_OF_SPACE,
  type GhosttyMouseInput,
  type GhosttyPointInput,
  type GhosttySelectionRange,
  type GhosttySnapshot,
  SELECTION_FORMAT_OPTIONS_SIZE,
} from "./coreTypes";

const decoder = new TextDecoder();

const encoder = new TextEncoder();

export class GhosttyTerminalCore {
  private readonly runtime: GhosttyRuntime;
  private terminalSlot = 0;
  private terminal = 0;
  private renderStateSlot = 0;
  private renderState = 0;
  private rowIteratorSlot = 0;
  private rowCellsSlot = 0;
  private inputEncoder: GhosttyInputEncoder | null = null;
  private ptyWriterId = 0;
  private ptyWriter: ((data: string) => void) | null = null;
  private scratch = 0;
  private style = 0;
  private scrollbar = 0;
  private snapshotReader!: GhosttySnapshotReader;
  private disposed = false;
  private keyboardLayoutMap: GhosttyKeyboardLayoutMap | undefined;

  private constructor(runtime: GhosttyRuntime) {
    this.runtime = runtime;
    void loadGhosttyKeyboardLayoutMap().then((layoutMap) => {
      if (!this.disposed) this.keyboardLayoutMap = layoutMap;
    });
  }

  static async create(
    cols: number,
    rows: number,
    cellWidth: number,
    cellHeight: number,
    theme: GhosttyTheme,
    onPtyData: (data: string) => void,
  ): Promise<GhosttyTerminalCore> {
    const core = new GhosttyTerminalCore(await loadGhosttyRuntime());

    try {
      core.initialize(cols, rows, cellWidth, cellHeight, theme, onPtyData);

      return core;
    } catch (error) {
      core.dispose();
      throw error;
    }
  }

  private initialize(
    cols: number,
    rows: number,
    cellWidth: number,
    cellHeight: number,
    theme: GhosttyTheme,
    onPtyData: (data: string) => void,
  ): void {
    const optionsSize = this.runtime.layout("GhosttyTerminalOptions").size;
    const options = this.runtime.alloc(optionsSize);
    this.runtime.setField(options, "GhosttyTerminalOptions", "cols", cols);
    this.runtime.setField(options, "GhosttyTerminalOptions", "rows", rows);
    this.runtime.setField(options, "GhosttyTerminalOptions", "max_scrollback", MAX_SCROLLBACK_ROWS);
    this.terminalSlot = this.runtime.allocOpaque();
    const terminalResult = this.runtime.call("ghostty_terminal_new", 0, this.terminalSlot, options);
    this.runtime.free(options, optionsSize);
    assertGhosttySuccess("ghostty_terminal_new", terminalResult);
    this.terminal = this.runtime.readPointer(this.terminalSlot);
    this.applyDefaultCursorBlink();
    this.ptyWriter = onPtyData;
    this.ptyWriterId = this.runtime.attachPtyWriter(this.terminal, onPtyData);

    this.renderStateSlot = this.runtime.allocOpaque();
    assertGhosttySuccess(
      "ghostty_render_state_new",
      this.runtime.call("ghostty_render_state_new", 0, this.renderStateSlot),
    );
    this.renderState = this.runtime.readPointer(this.renderStateSlot);

    this.rowIteratorSlot = this.runtime.allocOpaque();
    assertGhosttySuccess(
      "ghostty_render_state_row_iterator_new",
      this.runtime.call("ghostty_render_state_row_iterator_new", 0, this.rowIteratorSlot),
    );
    this.rowCellsSlot = this.runtime.allocOpaque();
    assertGhosttySuccess(
      "ghostty_render_state_row_cells_new",
      this.runtime.call("ghostty_render_state_row_cells_new", 0, this.rowCellsSlot),
    );

    this.scratch = this.runtime.alloc(16);
    this.inputEncoder = new GhosttyInputEncoder(this.runtime, this.terminal, this.scratch);
    this.inputEncoder.initialize();
    const styleSize = this.runtime.layout("GhosttyStyle").size;
    this.style = this.runtime.alloc(styleSize);
    this.runtime.setField(this.style, "GhosttyStyle", "size", styleSize);
    this.scrollbar = this.runtime.alloc(this.runtime.layout("GhosttyTerminalScrollbar").size);
    this.snapshotReader = new GhosttySnapshotReader(
      this.runtime,
      this.renderState,
      this.rowIteratorSlot,
      this.rowCellsSlot,
      this.scratch,
      this.style,
    );
    this.setTheme(theme);
    this.resize(cols, rows, cellWidth, cellHeight);
  }

  write(data: string | Uint8Array): void {
    this.ensureActive();
    const bytes = Predicate.isString(data) ? encoder.encode(data) : data;

    if (bytes.length === 0) return;
    const pointer = this.runtime.alloc(bytes.length);
    this.runtime.bytes(pointer, bytes.length).set(bytes);
    this.runtime.call("ghostty_terminal_vt_write", this.terminal, pointer, bytes.length);
    this.runtime.free(pointer, bytes.length);
  }

  resetAndWrite(data: string): void {
    this.ensureActive();
    this.runtime.call("ghostty_terminal_reset", this.terminal);
    // RIS returns the cursor to Ghostty's built-in steady default, so the
    // embedder default has to be applied again before the replay runs.
    this.applyDefaultCursorBlink();
    this.snapshotReader.reset();

    if (data.length === 0) return;
    const writer = this.ptyWriter;

    if (this.ptyWriterId !== 0) {
      this.runtime.detachPtyWriter(this.terminal, this.ptyWriterId);
      this.ptyWriterId = 0;
    }

    try {
      this.write(data);
    } finally {
      if (writer !== null && !this.disposed) {
        this.ptyWriterId = this.runtime.attachPtyWriter(this.terminal, writer);
      }
    }
  }

  resize(cols: number, rows: number, cellWidth: number, cellHeight: number): void {
    this.ensureActive();
    assertGhosttySuccess(
      "ghostty_terminal_resize",
      this.runtime.call(
        "ghostty_terminal_resize",
        this.terminal,
        Math.max(1, Math.min(65_535, cols)),
        Math.max(1, Math.min(65_535, rows)),
        Math.max(1, Math.round(cellWidth)),
        Math.max(1, Math.round(cellHeight)),
      ),
    );
  }

  /**
   * Ghostty's built-in default cursor is steady, while the xterm.js renderer
   * this replaced ran with `cursorBlink: true`. Option 23 is the embedder's
   * default blink, which is the state a session starts in and returns to on
   * DECSCUSR reset (CSI 0 q), so programs that ask for a specific cursor
   * through DECSCUSR or DEC mode 12 still win.
   */
  private applyDefaultCursorBlink(): void {
    const blink = this.runtime.alloc(1);
    this.runtime.bytes(blink, 1)[0] = 1;
    this.runtime.call("ghostty_terminal_set", this.terminal, 23, blink);
    this.runtime.free(blink, 1);
  }

  setTheme(theme: GhosttyTheme): void {
    this.ensureActive();
    const color = this.runtime.alloc(3);

    for (const [option, value] of [
      [11, theme.foreground],
      [12, theme.background],
      [13, theme.cursor],
    ] as const) {
      this.runtime.bytes(color, 3).set([value.r, value.g, value.b]);
      this.runtime.call("ghostty_terminal_set", this.terminal, option, color);
    }

    this.runtime.free(color, 3);
  }

  scroll(deltaRows: number): void {
    this.ensureActive();
    const layout = this.runtime.layout("GhosttyTerminalScrollViewport");
    const scroll = this.runtime.alloc(layout.size);
    this.runtime.setField(scroll, "GhosttyTerminalScrollViewport", "tag", 2);
    const value = layout.fields.value!;
    this.runtime.view(scroll + value.offset, value.size).setInt32(0, deltaRows, true);
    this.runtime.call("ghostty_terminal_scroll_viewport", this.terminal, scroll);
    this.runtime.free(scroll, layout.size);
  }

  scrollToBottom(): void {
    this.ensureActive();
    const layout = this.runtime.layout("GhosttyTerminalScrollViewport");
    const scroll = this.runtime.alloc(layout.size);
    this.runtime.setField(scroll, "GhosttyTerminalScrollViewport", "tag", 1);
    this.runtime.call("ghostty_terminal_scroll_viewport", this.terminal, scroll);
    this.runtime.free(scroll, layout.size);
  }

  isViewportActive(): boolean {
    this.ensureActive();
    this.runtime.bytes(this.scratch, 1)[0] = 0;

    return (
      this.runtime.call("ghostty_terminal_get", this.terminal, 32, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.bytes(this.scratch, 1)[0] !== 0
    );
  }

  scrollbarState(): GhosttyScrollbar | null {
    this.ensureActive();
    const layout = this.runtime.layout("GhosttyTerminalScrollbar");
    this.runtime.bytes(this.scrollbar, layout.size).fill(0);

    if (
      this.runtime.call("ghostty_terminal_get", this.terminal, 9, this.scrollbar) !==
      GHOSTTY_SUCCESS
    ) {
      return null;
    }

    return {
      total: this.runtime.readField(this.scrollbar, "GhosttyTerminalScrollbar", "total"),
      offset: this.runtime.readField(this.scrollbar, "GhosttyTerminalScrollbar", "offset"),
      len: this.runtime.readField(this.scrollbar, "GhosttyTerminalScrollbar", "len"),
    };
  }

  isMouseTracking(): boolean {
    this.ensureActive();
    this.runtime.bytes(this.scratch, 1)[0] = 0;

    return (
      this.runtime.call("ghostty_terminal_get", this.terminal, 11, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.bytes(this.scratch, 1)[0] !== 0
    );
  }

  isMouseAnyEventTracking(): boolean {
    this.ensureActive();
    this.runtime.bytes(this.scratch, 1)[0] = 0;

    return (
      this.runtime.call("ghostty_terminal_mode_get", this.terminal, 1003, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.bytes(this.scratch, 1)[0] !== 0
    );
  }

  isAlternateScreen(): boolean {
    this.ensureActive();
    this.runtime.bytes(this.scratch, 4).fill(0);

    return (
      this.runtime.call("ghostty_terminal_get", this.terminal, 6, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.view(this.scratch, 4).getUint32(0, true) === 1
    );
  }

  isApplicationCursorKeys(): boolean {
    this.ensureActive();
    this.runtime.bytes(this.scratch, 1)[0] = 0;

    return (
      this.runtime.call("ghostty_terminal_mode_get", this.terminal, 1, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.bytes(this.scratch, 1)[0] !== 0
    );
  }

  setSelection(anchor: GhosttyPointInput, end: GhosttyPointInput): void {
    this.ensureActive();
    const selectionLayout = this.runtime.layout("GhosttySelection");
    const gridRefSize = this.runtime.layout("GhosttyGridRef").size;
    const selection = this.runtime.alloc(selectionLayout.size);
    let start = 0;
    let endRef = 0;

    try {
      this.runtime.setField(selection, "GhosttySelection", "size", selectionLayout.size);
      start = this.gridRef(anchor.x, anchor.y, anchor.tag ?? 1);
      endRef = this.gridRef(end.x, end.y, end.tag ?? 1);
      const startField = selectionLayout.fields.start!;
      const endField = selectionLayout.fields.end!;
      this.runtime
        .bytes(selection + startField.offset, startField.size)
        .set(this.runtime.bytes(start, startField.size));
      this.runtime
        .bytes(selection + endField.offset, endField.size)
        .set(this.runtime.bytes(endRef, endField.size));
      this.runtime.call("ghostty_terminal_set", this.terminal, 21, selection);
    } finally {
      this.runtime.free(start, gridRefSize);
      this.runtime.free(endRef, gridRefSize);
      this.runtime.free(selection, selectionLayout.size);
    }
  }

  encodeKey(event: KeyboardEvent, action: "press" | "release" = "press"): string {
    return this.activeInputEncoder().encodeKey(event, action, this.keyboardLayoutMap);
  }

  encodePaste(data: string): string {
    return this.activeInputEncoder().encodePaste(data);
  }

  encodeMouse(input: GhosttyMouseInput): string {
    return this.activeInputEncoder().encodeMouse(input);
  }

  selectAll(): void {
    this.ensureActive();
    const layout = this.runtime.layout("GhosttySelection");
    const selection = this.runtime.alloc(layout.size);
    this.runtime.setField(selection, "GhosttySelection", "size", layout.size);

    if (
      this.runtime.call("ghostty_terminal_select_all", this.terminal, selection) === GHOSTTY_SUCCESS
    ) {
      this.runtime.call("ghostty_terminal_set", this.terminal, 21, selection);
    }

    this.runtime.free(selection, layout.size);
  }

  selectWord(col: number, row: number): GhosttySelectionRange | null {
    return this.selectAt(
      "GhosttyTerminalSelectWordOptions",
      "ghostty_terminal_select_word",
      col,
      row,
    );
  }

  selectLine(col: number, row: number): GhosttySelectionRange | null {
    return this.selectAt(
      "GhosttyTerminalSelectLineOptions",
      "ghostty_terminal_select_line",
      col,
      row,
    );
  }

  hyperlinkAt(col: number, row: number): string | null {
    this.ensureActive();
    const ref = this.gridRef(col, row);
    const written = this.runtime.call("ghostty_wasm_alloc_usize");
    const sizeResult = this.runtime.call("ghostty_grid_ref_hyperlink_uri", ref, 0, 0, written);
    const outputSize = this.runtime.view(written, 4).getUint32(0, true);
    let hyperlink: string | null = null;

    if (sizeResult === GHOSTTY_OUT_OF_SPACE && outputSize > 0) {
      const output = this.runtime.alloc(outputSize);

      const result = this.runtime.call(
        "ghostty_grid_ref_hyperlink_uri",
        ref,
        output,
        outputSize,
        written,
      );

      const outputLength = this.runtime.view(written, 4).getUint32(0, true);

      if (result === GHOSTTY_SUCCESS && outputLength > 0) {
        hyperlink = decoder.decode(this.runtime.bytes(output, outputLength));
      }

      this.runtime.free(output, outputSize);
    }

    this.runtime.call("ghostty_wasm_free_usize", written);
    this.runtime.free(ref, this.runtime.layout("GhosttyGridRef").size);

    return hyperlink;
  }

  clearSelection(): void {
    this.ensureActive();
    this.runtime.call("ghostty_terminal_set", this.terminal, 21, 0);
  }

  snapshot(): GhosttySnapshot {
    this.ensureActive();

    return this.snapshotReader.snapshot(this.terminal);
  }

  selectionText(): string {
    this.ensureActive();
    const options = this.runtime.alloc(SELECTION_FORMAT_OPTIONS_SIZE);
    const optionsView = this.runtime.view(options, SELECTION_FORMAT_OPTIONS_SIZE);
    optionsView.setUint32(0, SELECTION_FORMAT_OPTIONS_SIZE, true);
    optionsView.setUint32(4, 0, true);
    optionsView.setUint8(8, 1);
    optionsView.setUint8(9, 1);
    optionsView.setUint32(12, 0, true);
    const written = this.runtime.call("ghostty_wasm_alloc_usize");

    const sizeResult = this.runtime.call(
      "ghostty_terminal_selection_format_buf",
      this.terminal,
      options,
      0,
      0,
      written,
    );

    const outputSize = this.runtime.view(written, 4).getUint32(0, true);
    let text = "";

    if (sizeResult === GHOSTTY_OUT_OF_SPACE && outputSize > 0) {
      const output = this.runtime.alloc(outputSize);

      const result = this.runtime.call(
        "ghostty_terminal_selection_format_buf",
        this.terminal,
        options,
        output,
        outputSize,
        written,
      );

      const outputLength = this.runtime.view(written, 4).getUint32(0, true);

      if (result === GHOSTTY_SUCCESS) {
        text = decoder.decode(this.runtime.bytes(output, outputLength));
      }

      this.runtime.free(output, outputSize);
    }

    this.runtime.call("ghostty_wasm_free_usize", written);
    this.runtime.free(options, SELECTION_FORMAT_OPTIONS_SIZE);

    return text;
  }

  viewportPointToScreen(col: number, row: number): { x: number; y: number } | null {
    return this.convertPoint(col, row, 1, 2);
  }

  screenPointToViewport(col: number, row: number): { x: number; y: number } | null {
    return this.convertPoint(col, row, 2, 1);
  }

  private convertPoint(
    col: number,
    row: number,
    fromTag: 1 | 2,
    toTag: 1 | 2,
  ): { x: number; y: number } | null {
    this.ensureActive();
    const ref = this.gridRef(col, row, fromTag);
    const point = this.pointFromGridRef(ref, toTag);
    this.runtime.free(ref, this.runtime.layout("GhosttyGridRef").size);

    return point;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inputEncoder?.dispose();

    if (this.rowCellsSlot) {
      const cells = this.runtime.readPointer(this.rowCellsSlot);

      if (cells) this.runtime.call("ghostty_render_state_row_cells_free", cells);
    }

    if (this.rowIteratorSlot) {
      const iterator = this.runtime.readPointer(this.rowIteratorSlot);

      if (iterator) this.runtime.call("ghostty_render_state_row_iterator_free", iterator);
    }

    if (this.renderState) this.runtime.call("ghostty_render_state_free", this.renderState);

    if (this.terminal) {
      if (this.ptyWriterId) this.runtime.detachPtyWriter(this.terminal, this.ptyWriterId);
      this.runtime.call("ghostty_terminal_free", this.terminal);
    }

    if (this.style) this.runtime.free(this.style, this.runtime.layout("GhosttyStyle").size);

    if (this.scrollbar) {
      this.runtime.free(this.scrollbar, this.runtime.layout("GhosttyTerminalScrollbar").size);
    }

    if (this.scratch) this.runtime.free(this.scratch, 16);

    for (const slot of [
      this.rowCellsSlot,
      this.rowIteratorSlot,
      this.renderStateSlot,
      this.terminalSlot,
    ]) {
      this.runtime.freeOpaque(slot);
    }
  }

  private gridRef(col: number, row: number, tag: 1 | 2 = 1): number {
    const pointLayout = this.runtime.layout("GhosttyPoint");
    const point = this.runtime.alloc(pointLayout.size);
    this.runtime.setField(point, "GhosttyPoint", "tag", tag);
    const pointValue = pointLayout.fields.value!;
    const valueOffset = pointValue.offset;
    const view = this.runtime.view(point + valueOffset, pointValue.size);
    view.setUint16(0, Math.max(0, col), true);
    view.setUint32(4, Math.max(0, row), true);
    const gridRefSize = this.runtime.layout("GhosttyGridRef").size;
    const gridRef = this.runtime.alloc(gridRefSize);
    this.runtime.setField(gridRef, "GhosttyGridRef", "size", gridRefSize);
    const result = this.runtime.call("ghostty_terminal_grid_ref", this.terminal, point, gridRef);
    this.runtime.free(point, pointLayout.size);

    if (result !== GHOSTTY_SUCCESS) {
      this.runtime.free(gridRef, gridRefSize);
      assertGhosttySuccess("ghostty_terminal_grid_ref", result);
    }

    return gridRef;
  }

  private selectAt(
    optionsName: "GhosttyTerminalSelectWordOptions" | "GhosttyTerminalSelectLineOptions",
    operation: "ghostty_terminal_select_word" | "ghostty_terminal_select_line",
    col: number,
    row: number,
  ): GhosttySelectionRange | null {
    this.ensureActive();
    const optionsLayout = this.runtime.layout(optionsName);
    const selectionLayout = this.runtime.layout("GhosttySelection");
    const options = this.runtime.alloc(optionsLayout.size);
    let ref = 0;
    let selection = 0;
    let range: GhosttySelectionRange | null = null;

    try {
      this.runtime.setField(options, optionsName, "size", optionsLayout.size);
      ref = this.gridRef(col, row);
      const refField = optionsLayout.fields.ref!;
      this.runtime
        .bytes(options + refField.offset, refField.size)
        .set(this.runtime.bytes(ref, refField.size));
      selection = this.runtime.alloc(selectionLayout.size);
      this.runtime.setField(selection, "GhosttySelection", "size", selectionLayout.size);
      const result = this.runtime.call(operation, this.terminal, options, selection);

      if (result === GHOSTTY_SUCCESS) {
        const start = selection + selectionLayout.fields.start!.offset;
        const end = selection + selectionLayout.fields.end!.offset;
        const viewportStart = this.pointFromGridRef(start, 1);
        const viewportEnd = this.pointFromGridRef(end, 1);
        const screenStart = this.pointFromGridRef(start, 2);
        const screenEnd = this.pointFromGridRef(end, 2);

        if (viewportStart && viewportEnd && screenStart && screenEnd) {
          range = {
            viewport: { start: viewportStart, end: viewportEnd },
            screen: { start: screenStart, end: screenEnd },
          };
        }

        this.runtime.call("ghostty_terminal_set", this.terminal, 21, selection);
      }
    } finally {
      this.runtime.free(selection, selectionLayout.size);
      this.runtime.free(ref, this.runtime.layout("GhosttyGridRef").size);
      this.runtime.free(options, optionsLayout.size);
    }

    return range;
  }

  private pointFromGridRef(ref: number, tag: 1 | 2): { x: number; y: number } | null {
    const coordinateLayout = this.runtime.layout("GhosttyPointCoordinate");
    const coordinate = this.runtime.alloc(coordinateLayout.size);

    const result = this.runtime.call(
      "ghostty_terminal_point_from_grid_ref",
      this.terminal,
      ref,
      tag,
      coordinate,
    );

    const point =
      result === GHOSTTY_SUCCESS
        ? {
            x: this.runtime.readField(coordinate, "GhosttyPointCoordinate", "x"),
            y: this.runtime.readField(coordinate, "GhosttyPointCoordinate", "y"),
          }
        : null;

    this.runtime.free(coordinate, coordinateLayout.size);

    return point;
  }

  private activeInputEncoder(): GhosttyInputEncoder {
    this.ensureActive();

    if (this.inputEncoder === null) throw new Error("libghostty-vt input encoder is missing");

    return this.inputEncoder;
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error("libghostty-vt terminal has been disposed");
  }
}

export {
  GHOSTTY_CELL_WIDE,
  type GhosttyColor,
  type GhosttyTheme,
  type GhosttyCell,
  type GhosttyRow,
  type GhosttySnapshot,
  type GhosttySelectionRange,
  type GhosttyScrollbar,
  type GhosttyPointInput,
  type GhosttyMouseInput,
  ghosttyColorsEqual,
} from "./coreTypes";

export { ghosttyCellText } from "./coreSnapshot";
