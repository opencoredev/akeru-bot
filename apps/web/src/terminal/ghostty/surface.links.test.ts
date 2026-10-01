import { describe, expect, it } from "vite-plus/test";
import type { GhosttyRow } from "./core";
import {
  advanceTerminalSelectionClickSequence,
  isTerminalLinkPointerGesture,
  terminalLinkAtColumn,
  terminalLinkAtPosition,
  terminalLinkAtPositionWithRange,
} from "./surface";
import { cell } from "./surface.test-support";

describe("terminalLinkAtColumn", () => {
  it("maps terminal cells to UTF-16 offsets after a wide emoji", () => {
    const cells = [
      cell("🙂"),
      cell(""),
      ...Array.from("https://t3.codes", (character) => cell(character)),
    ];

    const row: GhosttyRow = {
      cells,
      text: cells
        .map((value) => value.text || " ")
        .join("")
        .trimEnd(),
      isWrapContinuation: false,
      wrapsToNext: false,
    };

    expect(terminalLinkAtColumn(row, 2)).toBe("https://t3.codes");
    expect(terminalLinkAtColumn(row, cells.length - 1)).toBe("https://t3.codes");
    expect(terminalLinkAtColumn(row, 0)).toBeNull();
    expect(terminalLinkAtPositionWithRange([row], 0, 8)?.range).toEqual({
      start: { x: 2, y: 0 },
      end: { x: cells.length - 1, y: 0 },
    });
  });

  it("uses shared path matching and reconstructs soft-wrapped links", () => {
    const row = (text: string, isWrapContinuation: boolean, wrapsToNext = false): GhosttyRow => ({
      cells: Array.from(text.padEnd(16), (character) => cell(character)),
      text: text.trimEnd(),
      isWrapContinuation,
      wrapsToNext,
    });

    const rows = [
      row("https://example.", false),
      row("com/reference", true),
      row("~/project/file", false),
      row("C:\\repo\\file.ts", false),
    ];

    expect(terminalLinkAtPosition(rows, 0, 8)).toBe("https://example.com/reference");
    expect(terminalLinkAtPosition(rows, 1, 4)).toBe("https://example.com/reference");
    expect(terminalLinkAtPosition(rows, 2, 2)).toBe("~/project/file");
    expect(terminalLinkAtPosition(rows, 3, 4)).toBe("C:\\repo\\file.ts");
    expect(terminalLinkAtPositionWithRange(rows, 1, 4)).toEqual({
      text: "https://example.com/reference",
      range: {
        start: { x: 0, y: 0 },
        end: { x: 12, y: 1 },
      },
    });
  });

  it("refuses links truncated at the viewport edges instead of mis-resolving", () => {
    const row = (text: string, isWrapContinuation: boolean, wrapsToNext = false): GhosttyRow => ({
      cells: Array.from(text.padEnd(16), (character) => cell(character)),
      text: text.trimEnd(),
      isWrapContinuation,
      wrapsToNext,
    });

    // The head of the wrapped line scrolled above the viewport.
    const headCut = [row("ple.com/missing", true), row("head", true)];
    expect(terminalLinkAtPosition(headCut, 0, 4)).toBeNull();
    // The bottom row soft-wraps on below the viewport.
    const tailCut = [row("https://t3.codes", false, true)];
    expect(terminalLinkAtPosition(tailCut, 0, 8)).toBeNull();
    // A partial bottom row is provably complete and still resolves.
    const complete = [row("https://t3.codes", false), row("", false)];
    expect(terminalLinkAtPosition(complete, 0, 8)).toBe("https://t3.codes");

    // A wide grapheme earlier in the row must not break truncation detection:
    // the soft-wrap flag decides, not string-length-versus-cell-count.
    const wideFull: GhosttyRow = {
      cells: [
        { ...cell("🙂"), wide: 1 },
        { ...cell(""), wide: 2 },
        ...Array.from("https://t3.code", (character) => cell(character)),
      ],
      text: "🙂 https://t3.code",
      isWrapContinuation: false,
      wrapsToNext: true,
    };

    expect(terminalLinkAtPosition([wideFull], 0, 8)).toBeNull();

    // Unwritten trailing cells prove the bottom row is complete.
    const unwrittenTail: GhosttyRow = {
      cells: [
        ...Array.from("https://t3.codes", (character) => cell(character)),
        cell(""),
        cell(""),
      ],
      text: "https://t3.codes",
      isWrapContinuation: false,
      wrapsToNext: false,
    };

    expect(terminalLinkAtPosition([unwrittenTail], 0, 8)).toBe("https://t3.codes");
  });
});

describe("isTerminalLinkPointerGesture", () => {
  it("uses Command on macOS and Control elsewhere", () => {
    expect(isTerminalLinkPointerGesture({ ctrlKey: false, metaKey: true }, "MacIntel")).toBe(true);
    expect(isTerminalLinkPointerGesture({ ctrlKey: true, metaKey: false }, "MacIntel")).toBe(false);
    expect(isTerminalLinkPointerGesture({ ctrlKey: true, metaKey: false }, "Linux x86_64")).toBe(
      true,
    );
    expect(isTerminalLinkPointerGesture({ ctrlKey: false, metaKey: true }, "Linux x86_64")).toBe(
      false,
    );
  });
});

describe("advanceTerminalSelectionClickSequence", () => {
  it("recognizes stationary double and triple pointer presses without PointerEvent.detail", () => {
    const first = advanceTerminalSelectionClickSequence(null, {
      clientX: 20,
      clientY: 30,
      timeStamp: 1_000,
    });

    const second = advanceTerminalSelectionClickSequence(first, {
      clientX: 22,
      clientY: 29,
      timeStamp: 1_200,
    });

    const third = advanceTerminalSelectionClickSequence(second, {
      clientX: 21,
      clientY: 31,
      timeStamp: 1_400,
    });

    expect([first.count, second.count, third.count]).toEqual([1, 2, 3]);
  });

  it("starts over after movement, delay, or a completed triple click", () => {
    const previous = { count: 3, time: 1_000, x: 20, y: 30 };
    expect(
      advanceTerminalSelectionClickSequence(previous, {
        clientX: 20,
        clientY: 30,
        timeStamp: 1_100,
      }).count,
    ).toBe(1);
    expect(
      advanceTerminalSelectionClickSequence(previous, {
        clientX: 30,
        clientY: 30,
        timeStamp: 1_100,
      }).count,
    ).toBe(1);
    expect(
      advanceTerminalSelectionClickSequence(previous, {
        clientX: 20,
        clientY: 30,
        timeStamp: 1_501,
      }).count,
    ).toBe(1);
  });
});
