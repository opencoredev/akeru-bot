import { measureGhosttyCell, type GhosttyCellMetrics } from "./renderer";
import {
  type GhosttyTerminalFont,
  loadTerminalFontFamily,
  terminalFontFamily,
  terminalFontSize,
} from "./surfaceFont";

interface SurfaceFontHost {
  readonly context: CanvasRenderingContext2D;
  readonly disposed: boolean;
  readonly metrics: GhosttyCellMetrics;
  /** Re-measures with the current face and refits the grid. */
  applyFontMetrics(): void;
}

/**
 * Tracks the face and size the surface renders with. It applies requested
 * fonts once they load, and re-measures when a late webfont changes glyphs.
 */
export class SurfaceFontController {
  constructor(
    private readonly host: SurfaceFontHost,
    fontFamily: string,
    font: GhosttyTerminalFont | undefined,
  ) {
    this.fontFamily = fontFamily;
    this.requestedFontFamily = font?.family;
    this.fontSize = terminalFontSize(font?.size);
  }

  fontFamily: string;

  fontSize: number;

  private requestedFontFamily: string | undefined;

  private fontEpoch = 0;

  private pendingFontEpoch: number | null = null;

  measure(): GhosttyCellMetrics {
    return measureGhosttyCell(this.host.context, this.fontSize, this.fontFamily);
  }

  async setFont(font: GhosttyTerminalFont): Promise<void> {
    if (this.host.disposed) return;
    const fontSize = terminalFontSize(font.size);
    // The fields only change together with their metrics after the load, and
    // the epoch lets the newest overlapping call win regardless of load order.
    const epoch = ++this.fontEpoch;
    this.pendingFontEpoch = epoch;
    const fontFamily = await loadTerminalFontFamily(font.family, fontSize);

    if (this.host.disposed || epoch !== this.fontEpoch) return;
    this.pendingFontEpoch = null;
    this.fontFamily = fontFamily;
    this.requestedFontFamily = font.family;
    this.fontSize = fontSize;
    this.host.applyFontMetrics();
  }

  readonly onFontsLoaded = () => {
    if (this.host.disposed) return;

    // The explicit load validates every style and applies the newest request.
    // Its own loading events must not revalidate the previously applied face.
    if (this.pendingFontEpoch !== null) return;
    // A face may become available after an earlier fallback measurement. Run
    // the fixed-width guard again before using its newly loaded metrics.
    const fontFamily = terminalFontFamily(this.requestedFontFamily);

    if (fontFamily !== this.fontFamily) {
      this.fontFamily = fontFamily;
      this.host.applyFontMetrics();

      return;
    }

    // A face that finished loading after the initial measurement changes glyph
    // advances; re-measure and refit so the grid matches what actually renders.
    const metrics = this.measure();
    const current = this.host.metrics;

    if (
      metrics.width === current.width &&
      metrics.height === current.height &&
      metrics.baseline === current.baseline
    ) {
      return;
    }

    this.host.applyFontMetrics();
  };
}
