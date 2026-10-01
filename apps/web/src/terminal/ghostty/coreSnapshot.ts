import { GhosttyRuntime } from "./runtime";
import {
  type GhosttyColor,
  type GhosttyRow,
  type GhosttySnapshot,
  assertGhosttySuccess,
  type GhosttyCell,
  GHOSTTY_SUCCESS,
} from "./coreTypes";

const RENDER_DATA = {
  cols: 1,
  rows: 2,
  dirty: 3,
  rowIterator: 4,
  background: 5,
  foreground: 6,
  cursor: 7,
  cursorHasValue: 8,
  cursorStyle: 10,
  cursorVisible: 11,
  cursorBlinking: 12,
  cursorInViewport: 14,
  cursorX: 15,
  cursorY: 16,
} as const;

const ROW_DATA = {
  dirty: 1,
  raw: 2,
  cells: 3,
} as const;

const CELL_DATA = {
  raw: 1,
  style: 2,
  graphemesLength: 3,
  graphemes: 4,
  background: 5,
  foreground: 6,
  selected: 7,
} as const;

const RAW_CELL_DATA = {
  wide: 3,
} as const;

function blend(foreground: GhosttyColor, background: GhosttyColor): GhosttyColor {
  const channel = (front: number, back: number) => Math.floor((front * 155 + back * 100) / 255);

  return {
    r: channel(foreground.r, background.r),
    g: channel(foreground.g, background.g),
    b: channel(foreground.b, background.b),
  };
}

/**
 * A terminal program can print one base character followed by a huge run of
 * combining marks, packing hundreds of thousands of codepoints into a single
 * cell that still fits the scrollback buffer. Engines cap spread-call
 * arguments far below that, so convert in bounded chunks instead of spreading
 * every codepoint into String.fromCodePoint at once.
 */
export function ghosttyCellText(codepointView: DataView, graphemeLength: number): string {
  const CHUNK_SIZE = 4_096;
  let text = "";

  for (let start = 0; start < graphemeLength; start += CHUNK_SIZE) {
    const count = Math.min(CHUNK_SIZE, graphemeLength - start);
    const codes = new Array<number>(count);

    for (let index = 0; index < count; index += 1) {
      codes[index] = codepointView.getUint32((start + index) * 4, true);
    }

    text += String.fromCodePoint(...codes);
  }

  return text;
}

export class GhosttySnapshotReader {
  private rows: GhosttyRow[] = [];
  constructor(
    private readonly runtime: GhosttyRuntime,
    private readonly renderState: number,
    private readonly rowIteratorSlot: number,
    private readonly rowCellsSlot: number,
    private readonly scratch: number,
    private readonly style: number,
  ) {}
  reset() {
    this.rows = [];
  }

  snapshot(terminal: number): GhosttySnapshot {
    assertGhosttySuccess(
      "ghostty_render_state_update",
      this.runtime.call("ghostty_render_state_update", this.renderState, terminal),
    );
    const cols = this.getU16(RENDER_DATA.cols);
    const rowCount = this.getU16(RENDER_DATA.rows);
    const dirty = this.getU32(RENDER_DATA.dirty);
    const foreground = this.getColor(RENDER_DATA.foreground, { r: 229, g: 231, b: 235 });
    const background = this.getColor(RENDER_DATA.background, { r: 0, g: 0, b: 0 });
    const cursorHasValue = this.getBool(RENDER_DATA.cursorHasValue);
    const cursor = cursorHasValue ? this.getColor(RENDER_DATA.cursor, foreground) : foreground;
    const cursorInViewport = this.getBool(RENDER_DATA.cursorInViewport);
    const cursorVisible = this.getBool(RENDER_DATA.cursorVisible) && cursorInViewport;
    const cursorX = cursorInViewport ? this.getU16(RENDER_DATA.cursorX) : -1;
    const cursorY = cursorInViewport ? this.getU16(RENDER_DATA.cursorY) : -1;

    if (this.rows.length !== rowCount || this.rows.some((row) => row.cells.length !== cols)) {
      this.rows = Array.from({ length: rowCount }, () => ({
        cells: Array.from({ length: cols }, () => this.emptyCell(foreground, background)),
        text: "",
        isWrapContinuation: false,
        wrapsToNext: false,
      }));
    }

    const dirtyRows = new Set<number>();

    if (dirty !== 0) {
      assertGhosttySuccess(
        "ghostty_render_state_get(row iterator)",
        this.runtime.call(
          "ghostty_render_state_get",
          this.renderState,
          RENDER_DATA.rowIterator,
          this.rowIteratorSlot,
        ),
      );
      const iterator = this.runtime.readPointer(this.rowIteratorSlot);
      let rowIndex = 0;

      while (
        rowIndex < rowCount &&
        this.runtime.call("ghostty_render_state_row_iterator_next", iterator) !== 0
      ) {
        const rowDirty = dirty === 2 || this.getRowBool(iterator, ROW_DATA.dirty);

        if (rowDirty) {
          this.rows[rowIndex] = this.readRow(iterator, cols, foreground, background);
          dirtyRows.add(rowIndex);
          this.runtime.bytes(this.scratch, 1)[0] = 0;
          this.runtime.call("ghostty_render_state_row_set", iterator, 0, this.scratch);
        }

        rowIndex += 1;
      }

      this.runtime.view(this.scratch, 4).setUint32(0, 0, true);
      this.runtime.call("ghostty_render_state_set", this.renderState, 0, this.scratch);
    }

    return {
      cols,
      rows: rowCount,
      foreground,
      background,
      cursor,
      cursorX,
      cursorY,
      cursorVisible,
      cursorBlinking: this.getBool(RENDER_DATA.cursorBlinking),
      cursorStyle: this.getU32(RENDER_DATA.cursorStyle),
      dirtyRows,
      rowData: this.rows,
    };
  }

  private readRow(
    iterator: number,
    cols: number,
    defaultForeground: GhosttyColor,
    defaultBackground: GhosttyColor,
  ): GhosttyRow {
    assertGhosttySuccess(
      "ghostty_render_state_row_get(raw)",
      this.runtime.call("ghostty_render_state_row_get", iterator, ROW_DATA.raw, this.scratch),
    );
    const rawRow = this.runtime.view(this.scratch, 8).getBigUint64(0, true);
    this.runtime.bytes(this.scratch + 8, 1)[0] = 0;
    assertGhosttySuccess(
      "ghostty_row_get(wrap continuation)",
      this.runtime.call("ghostty_row_get", rawRow, 2, this.scratch + 8),
    );
    const isWrapContinuation = this.runtime.bytes(this.scratch + 8, 1)[0] !== 0;
    this.runtime.bytes(this.scratch + 8, 1)[0] = 0;
    assertGhosttySuccess(
      "ghostty_row_get(wrap)",
      this.runtime.call("ghostty_row_get", rawRow, 1, this.scratch + 8),
    );
    const wrapsToNext = this.runtime.bytes(this.scratch + 8, 1)[0] !== 0;

    assertGhosttySuccess(
      "ghostty_render_state_row_get(cells)",
      this.runtime.call(
        "ghostty_render_state_row_get",
        iterator,
        ROW_DATA.cells,
        this.rowCellsSlot,
      ),
    );
    const cellsIterator = this.runtime.readPointer(this.rowCellsSlot);
    const cells: GhosttyCell[] = [];

    while (
      cells.length < cols &&
      this.runtime.call("ghostty_render_state_row_cells_next", cellsIterator) !== 0
    ) {
      let foreground = this.getCellColor(cellsIterator, CELL_DATA.foreground, defaultForeground);
      let background = this.getCellColor(cellsIterator, CELL_DATA.background, defaultBackground);
      const styleSize = this.runtime.layout("GhosttyStyle").size;
      this.runtime.bytes(this.style, styleSize).fill(0);
      this.runtime.setField(this.style, "GhosttyStyle", "size", styleSize);
      this.runtime.call(
        "ghostty_render_state_row_cells_get",
        cellsIterator,
        CELL_DATA.style,
        this.style,
      );
      const inverse = this.runtime.readField(this.style, "GhosttyStyle", "inverse") !== 0;

      if (inverse) [foreground, background] = [background, foreground];

      if (this.runtime.readField(this.style, "GhosttyStyle", "faint") !== 0) {
        foreground = blend(foreground, background);
      }

      const graphemeLength = this.getCellU32(cellsIterator, CELL_DATA.graphemesLength);
      let text = "";

      if (graphemeLength > 0) {
        const bufferSize = graphemeLength * 4;
        const codepoints = this.runtime.alloc(bufferSize);

        if (
          this.runtime.call(
            "ghostty_render_state_row_cells_get",
            cellsIterator,
            CELL_DATA.graphemes,
            codepoints,
          ) === GHOSTTY_SUCCESS
        ) {
          // Read through a DataView: the byte-array allocator guarantees no
          // 4-byte alignment, which a Uint32Array view would require.
          const codepointView = this.runtime.view(codepoints, bufferSize);
          text = ghosttyCellText(codepointView, graphemeLength);
        }

        this.runtime.free(codepoints, bufferSize);
      }

      let wide = 0;

      if (text.length === 0 && cells.at(-1)?.text.length) {
        assertGhosttySuccess(
          "ghostty_render_state_row_cells_get(raw)",
          this.runtime.call(
            "ghostty_render_state_row_cells_get",
            cellsIterator,
            CELL_DATA.raw,
            this.scratch,
          ),
        );
        const rawCell = this.runtime.view(this.scratch, 8).getBigUint64(0, true);
        this.runtime.view(this.scratch + 8, 4).setUint32(0, 0, true);
        assertGhosttySuccess(
          "ghostty_cell_get(wide)",
          this.runtime.call("ghostty_cell_get", rawCell, RAW_CELL_DATA.wide, this.scratch + 8),
        );
        wide = this.runtime.view(this.scratch + 8, 4).getUint32(0, true);
      }

      cells.push({
        text,
        wide,
        foreground,
        background,
        bold: this.runtime.readField(this.style, "GhosttyStyle", "bold") !== 0,
        italic: this.runtime.readField(this.style, "GhosttyStyle", "italic") !== 0,
        invisible: this.runtime.readField(this.style, "GhosttyStyle", "invisible") !== 0,
        strikethrough: this.runtime.readField(this.style, "GhosttyStyle", "strikethrough") !== 0,
        overline: this.runtime.readField(this.style, "GhosttyStyle", "overline") !== 0,
        underline: this.runtime.readField(this.style, "GhosttyStyle", "underline") !== 0,
        selected: this.getCellBool(cellsIterator, CELL_DATA.selected),
      });
    }

    while (cells.length < cols) cells.push(this.emptyCell(defaultForeground, defaultBackground));

    return {
      cells,
      text: cells
        .map((cell) => cell.text || " ")
        .join("")
        .trimEnd(),
      isWrapContinuation,
      wrapsToNext,
    };
  }

  private getU16(data: number): number {
    this.runtime.bytes(this.scratch, 2).fill(0);
    assertGhosttySuccess(
      "ghostty_render_state_get",
      this.runtime.call("ghostty_render_state_get", this.renderState, data, this.scratch),
    );

    return this.runtime.view(this.scratch, 2).getUint16(0, true);
  }

  private getU32(data: number): number {
    this.runtime.bytes(this.scratch, 4).fill(0);
    assertGhosttySuccess(
      "ghostty_render_state_get",
      this.runtime.call("ghostty_render_state_get", this.renderState, data, this.scratch),
    );

    return this.runtime.view(this.scratch, 4).getUint32(0, true);
  }

  private getBool(data: number): boolean {
    this.runtime.bytes(this.scratch, 1)[0] = 0;
    assertGhosttySuccess(
      "ghostty_render_state_get",
      this.runtime.call("ghostty_render_state_get", this.renderState, data, this.scratch),
    );

    return this.runtime.bytes(this.scratch, 1)[0] !== 0;
  }

  private getColor(data: number, fallback: GhosttyColor): GhosttyColor {
    this.runtime.bytes(this.scratch, 3).fill(0);

    const result = this.runtime.call(
      "ghostty_render_state_get",
      this.renderState,
      data,
      this.scratch,
    );

    return result === GHOSTTY_SUCCESS ? this.readColor(this.scratch) : fallback;
  }

  private getRowBool(iterator: number, data: number): boolean {
    this.runtime.bytes(this.scratch, 1)[0] = 0;

    return (
      this.runtime.call("ghostty_render_state_row_get", iterator, data, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.bytes(this.scratch, 1)[0] !== 0
    );
  }

  private getCellU32(iterator: number, data: number): number {
    this.runtime.bytes(this.scratch, 4).fill(0);

    const result = this.runtime.call(
      "ghostty_render_state_row_cells_get",
      iterator,
      data,
      this.scratch,
    );

    return result === GHOSTTY_SUCCESS ? this.runtime.view(this.scratch, 4).getUint32(0, true) : 0;
  }

  private getCellBool(iterator: number, data: number): boolean {
    this.runtime.bytes(this.scratch, 1)[0] = 0;

    return (
      this.runtime.call("ghostty_render_state_row_cells_get", iterator, data, this.scratch) ===
        GHOSTTY_SUCCESS && this.runtime.bytes(this.scratch, 1)[0] !== 0
    );
  }

  private getCellColor(iterator: number, data: number, fallback: GhosttyColor): GhosttyColor {
    this.runtime.bytes(this.scratch, 3).fill(0);

    const result = this.runtime.call(
      "ghostty_render_state_row_cells_get",
      iterator,
      data,
      this.scratch,
    );

    return result === GHOSTTY_SUCCESS ? this.readColor(this.scratch) : fallback;
  }

  private readColor(pointer: number): GhosttyColor {
    const bytes = this.runtime.bytes(pointer, 3);

    return { r: bytes[0] ?? 0, g: bytes[1] ?? 0, b: bytes[2] ?? 0 };
  }

  private emptyCell(foreground: GhosttyColor, background: GhosttyColor): GhosttyCell {
    return {
      text: "",
      wide: 0,
      foreground,
      background,
      bold: false,
      italic: false,
      invisible: false,
      strikethrough: false,
      overline: false,
      underline: false,
      selected: false,
    };
  }
}
