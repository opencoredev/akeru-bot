import { describe, expect, it } from "vite-plus/test";
import {
  terminalGridCellAt,
  terminalScrollbarGeometry,
  terminalScrollbarOffsetAtPointer,
  terminalContentOriginY,
  terminalWheelArrowData,
  terminalWheelDeltaRows,
} from "./surface";

describe("terminalGridCellAt", () => {
  const options = {
    bounds: { left: 100, top: 200 },
    cols: 3,
    rows: 2,
    metrics: { width: 10, height: 20 },
    padding: 4,
    originY: 24,
  };

  it("maps points inside the rendered grid without clamping its padding", () => {
    expect(terminalGridCellAt({ ...options, clientX: 104, clientY: 224 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(terminalGridCellAt({ ...options, clientX: 133, clientY: 263 })).toEqual({
      x: 2,
      y: 1,
    });
    expect(terminalGridCellAt({ ...options, clientX: 103, clientY: 224 })).toBeNull();
    expect(terminalGridCellAt({ ...options, clientX: 104, clientY: 223 })).toBeNull();
    expect(terminalGridCellAt({ ...options, clientX: 134, clientY: 224 })).toBeNull();
    expect(terminalGridCellAt({ ...options, clientX: 104, clientY: 264 })).toBeNull();
  });
});

describe("terminalContentOriginY", () => {
  it("stays top-anchored like a fresh terminal until scrollback exists", () => {
    expect(terminalContentOriginY(100, 4, 5, 16, false)).toBe(4);
  });

  it("pins the grid to the bottom by moving the sub-row slack above row 0", () => {
    // 100px mount, 4px padding, 5 rows of 16px: 92 - 80 = 12px slack on top.
    expect(terminalContentOriginY(100, 4, 5, 16, true)).toBe(16);
    // Exact fit keeps the origin at the padding.
    expect(terminalContentOriginY(88, 4, 5, 16, true)).toBe(4);
    // A mount smaller than the grid never pushes the origin above the padding.
    expect(terminalContentOriginY(80, 4, 5, 16, true)).toBe(4);
  });

  it("keeps the prompt stationary while a drag crosses row boundaries", () => {
    // Growing the mount pixel by pixel: the bottom edge (origin + rows*cell)
    // tracks the mount bottom exactly until a new row fits.
    for (let height = 88; height < 104; height += 1) {
      const rows = Math.max(1, Math.floor((height - 8) / 16));
      const origin = terminalContentOriginY(height, 4, rows, 16, true);
      expect(origin + rows * 16).toBe(height - 4);
    }
  });
});

describe("terminalWheelDeltaRows", () => {
  it("converts line-mode deltas into whole rows", () => {
    const result = terminalWheelDeltaRows({ deltaY: 3, deltaMode: 1 }, 16, 24, 0);
    expect(result.rows).toBe(3);
    expect(result.remainder).toBe(0);
  });

  it("accumulates fractional pixel deltas across events", () => {
    let remainder = 0;
    let scrolled = 0;
    for (let index = 0; index < 4; index += 1) {
      const result = terminalWheelDeltaRows({ deltaY: 5, deltaMode: 0 }, 16, 24, remainder);
      remainder = result.remainder;
      scrolled += result.rows;
    }
    expect(scrolled).toBe(1);
    expect(remainder).toBeCloseTo(4 / 16);
  });

  it("keeps direction for negative page-mode deltas", () => {
    const result = terminalWheelDeltaRows({ deltaY: -1, deltaMode: 2 }, 16, 24, 0);
    expect(result.rows).toBe(-24);
    expect(result.remainder).toBe(0);
  });
});

describe("terminalWheelArrowData", () => {
  it("emits one arrow per row honoring application cursor keys", () => {
    expect(terminalWheelArrowData(-2, false)).toBe("\u001b[A\u001b[A");
    expect(terminalWheelArrowData(3, false)).toBe("\u001b[B\u001b[B\u001b[B");
    expect(terminalWheelArrowData(-1, true)).toBe("\u001bOA");
    expect(terminalWheelArrowData(0, true)).toBe("");
  });
});

describe("terminal scrollbar", () => {
  it("maps Ghostty's viewport state to a proportional thumb", () => {
    expect(terminalScrollbarGeometry({ total: 100, offset: 40, len: 20 }, 200)).toEqual({
      thumbHeight: 40,
      thumbTop: 80,
      maxOffset: 80,
    });
    expect(terminalScrollbarGeometry({ total: 100, offset: 0, len: 100 }, 200)).toBeNull();
  });

  it("keeps the thumb usable for large scrollback and maps dragging back to rows", () => {
    const state = { total: 10_000, offset: 0, len: 20 };
    expect(terminalScrollbarGeometry(state, 200)).toEqual({
      thumbHeight: 18,
      thumbTop: 0,
      maxOffset: 9_980,
    });
    expect(terminalScrollbarOffsetAtPointer(state, 200, 191, 9)).toBe(9_980);
  });
});
