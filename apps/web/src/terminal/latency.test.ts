import { describe, expect, it, vi } from "vite-plus/test";
import {
  formatLatencyReport,
  percentile,
  summarizeTerminalLatency,
  TerminalLatencyRecorder,
  terminalLatencyCallbacks,
} from "./latency";

const paint = (...glyphs: string[]) => ({
  rowData: [{ cells: glyphs.map((text) => ({ text })) }],
  dirtyRows: new Set([0]),
});

describe("terminal latency harness", () => {
  it("uses nearest-rank percentiles and handles empty input", () => {
    expect(percentile([9, 1, 5, 3, 7], 0.5)).toBe(5);
    expect(percentile([9, 1, 5, 3, 7], 0.95)).toBe(9);
    expect(percentile([], 0.5)).toBe(Number.NaN);
  });
  it("correlates bursts and leaves interleaved spontaneous output unkeyed", () => {
    const r = new TerminalLatencyRecorder();
    r.onGlyphPaint(0, paint("", "", ""));
    r.onKeypress(1, "a");
    r.onKeypress(2, "b");
    r.onByteArrival(3, "x");
    r.onByteArrival(4, "a");
    r.onByteArrival(5, "b");
    r.onGlyphPaint(10, paint("x", "a", "b"));
    expect(r.samples).toEqual([
      { keypressToGlyphMs: 9, byteArrivalToGlyphMs: 6 },
      { keypressToGlyphMs: 8, byteArrivalToGlyphMs: 5 },
      { byteArrivalToGlyphMs: 7 },
    ]);
  });
  it("correlates ordered echoes that arrive in one output chunk", () => {
    const r = new TerminalLatencyRecorder();
    r.onGlyphPaint(0, paint("", ""));
    r.onKeypress(1, "a");
    r.onKeypress(2, "b");
    r.onByteArrival(3, "ab");
    r.onGlyphPaint(5, paint("a", "b"));
    expect(r.samples).toEqual([
      { keypressToGlyphMs: 4, byteArrivalToGlyphMs: 2 },
      { keypressToGlyphMs: 3, byteArrivalToGlyphMs: 2 },
    ]);
  });
  it("does not guess which repeated key produced a shared echo", () => {
    const r = new TerminalLatencyRecorder();
    r.onGlyphPaint(0, paint("", ""));
    r.onKeypress(1, "a");
    r.onKeypress(2, "a");
    r.onByteArrival(3, "aa");
    r.onGlyphPaint(5, paint("a", "a"));
    expect(r.samples).toEqual([{ byteArrivalToGlyphMs: 2 }]);
  });
  it("does not count a paint that leaves the expected glyph unchanged", () => {
    const r = new TerminalLatencyRecorder();
    r.onGlyphPaint(0, paint("a"));
    r.onKeypress(1, "a");
    r.onByteArrival(2, "a");
    r.onGlyphPaint(3, paint("a"));
    expect(r.samples).toEqual([]);
  });
  it("bounds state and report resets the window", () => {
    const r = new TerminalLatencyRecorder();
    r.onGlyphPaint(0, paint(""));
    for (let i = 0; i < 700; i++) {
      r.onKeypress(i * 4, "a");
      r.onByteArrival(i * 4 + 1, "a");
      r.onGlyphPaint(i * 4 + 2, paint("a"));
      r.onGlyphPaint(i * 4 + 3, paint(""));
    }
    expect(r.samples.length).toBeLessThanOrEqual(512);
    expect(r.report()).toContain("n=512");
    expect(r.samples).toHaveLength(0);
    r.reset();
  });
  it("does not evaluate hooks when instrumentation is disabled", () => {
    const c = terminalLatencyCallbacks(undefined);
    const clock = vi.spyOn(performance, "now");
    c.onKeypress("a");
    c.onByteArrival("a");
    c.onGlyphPaint(paint("a"));
    expect(clock).not.toHaveBeenCalled();
  });
  it("reports both input paths", () => {
    const report = summarizeTerminalLatency([
      { keypressToGlyphMs: 4, byteArrivalToGlyphMs: 2 },
      { keypressToGlyphMs: 8, byteArrivalToGlyphMs: 3 },
      { byteArrivalToGlyphMs: 5 },
    ]);
    expect(report.keypressToGlyph.count).toBe(2);
    expect(report.byteArrivalToGlyph.p95).toBe(5);
    expect(formatLatencyReport("headless", [{ byteArrivalToGlyphMs: 1 }])).toContain(
      "byte-arrival-to-glyph: p50=1.00ms",
    );
  });
});
