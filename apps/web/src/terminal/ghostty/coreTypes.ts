export const GHOSTTY_SUCCESS = 0;

export const GHOSTTY_OUT_OF_SPACE = -3;

export const MAX_SCROLLBACK_ROWS = 10_000;

// wasm32 C ABI layout for GhosttyTerminalSelectionFormatOptions at the
// libghostty-vt revision pinned alongside this module.
export const SELECTION_FORMAT_OPTIONS_SIZE = 16;

export const GHOSTTY_CELL_WIDE = {
  narrow: 0,
  wide: 1,
  spacerTail: 2,
  spacerHead: 3,
} as const;

export interface GhosttyColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface GhosttyTheme {
  readonly foreground: GhosttyColor;
  readonly background: GhosttyColor;
  readonly cursor: GhosttyColor;
  /** CSS color the renderer overlays on selected cells; not sent to Ghostty. */
  readonly selectionBackground?: string;
}

export interface GhosttyCell {
  readonly text: string;
  readonly wide: number;
  readonly foreground: GhosttyColor;
  readonly background: GhosttyColor;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly invisible: boolean;
  readonly strikethrough: boolean;
  readonly overline: boolean;
  readonly underline: boolean;
  readonly selected: boolean;
}

export interface GhosttyRow {
  readonly cells: readonly GhosttyCell[];
  readonly text: string;
  readonly isWrapContinuation: boolean;
  /** Whether this row soft-wraps onto the next row. */
  readonly wrapsToNext: boolean;
}

export interface GhosttySnapshot {
  readonly cols: number;
  readonly rows: number;
  readonly foreground: GhosttyColor;
  readonly background: GhosttyColor;
  readonly cursor: GhosttyColor;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly cursorVisible: boolean;
  readonly cursorBlinking: boolean;
  readonly cursorStyle: number;
  readonly dirtyRows: ReadonlySet<number>;
  readonly rowData: readonly GhosttyRow[];
}

export interface GhosttySelectionRange {
  readonly viewport: {
    readonly start: { readonly x: number; readonly y: number };
    readonly end: { readonly x: number; readonly y: number };
  };
  readonly screen: {
    readonly start: { readonly x: number; readonly y: number };
    readonly end: { readonly x: number; readonly y: number };
  };
}

export interface GhosttyScrollbar {
  readonly total: number;
  readonly offset: number;
  readonly len: number;
}

/** Grid position tagged with its Ghostty coordinate space: 1 viewport, 2 screen. */
export interface GhosttyPointInput {
  readonly x: number;
  readonly y: number;
  readonly tag?: 1 | 2;
}

export interface GhosttyMouseInput {
  readonly action: "press" | "release" | "motion";
  readonly button: number | null;
  readonly mods: number;
  readonly x: number;
  readonly y: number;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly paddingLeft: number;
  readonly paddingRight: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
  readonly anyButtonPressed: boolean;
}

function sameColor(left: GhosttyColor, right: GhosttyColor): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b;
}

export function ghosttyColorsEqual(left: GhosttyColor, right: GhosttyColor): boolean {
  return sameColor(left, right);
}

export function assertGhosttySuccess(operation: string, result: number): void {
  if (result !== GHOSTTY_SUCCESS) throw new Error(`${operation} failed with result ${result}`);
}
