import type { GhosttyTheme } from "./core";
import type { TerminalLatencyProbe } from "../latency";
import type { GhosttyTerminalFont } from "./surfaceFont";

export interface GhosttySelectionPosition {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface GhosttyTerminalSurfaceOptions {
  readonly theme: GhosttyTheme;
  readonly font?: GhosttyTerminalFont;
  /** Read after font and WASM loading. Hosts can supply a getter for the latest value. */
  readonly visible?: boolean;
  readonly onData: (data: string) => void;
  /** Optional live measurement hooks; omitted in normal clients. */
  readonly latencyProbe?: TerminalLatencyProbe;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onSelectionChange: () => void;
  readonly beforeKey: (event: KeyboardEvent) => boolean;
  readonly onLinkActivate: (text: string, event: MouseEvent) => void;
  /**
   * A right-click the running application did not claim through mouse
   * reporting. The host owns the menu, so it also owns preventing the browser
   * default — whose Paste entry can never reach a canvas terminal.
   */
  readonly onContextMenu?: (event: MouseEvent) => void;
}
