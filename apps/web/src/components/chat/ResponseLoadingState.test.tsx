import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatLoadingElapsed,
  LOADER_CELL_DELAYS_MS,
  LOADER_RESTING_CELLS,
  ResponseLoadingState,
} from "./ResponseLoadingState";

const NOW = new Date("2026-09-15T18:00:00.000Z");
const since = (elapsedMs: number) => new Date(NOW.getTime() - elapsedMs).toISOString();

describe("ResponseLoadingState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("staggers the meter cells into a left-to-right wavefront", () => {
    expect([...LOADER_CELL_DELAYS_MS]).toEqual([90, 180, 270, 0, 90, 180, 90, 180, 270]);
  });

  it("rests on a right-pointing chevron after the sweep", () => {
    expect([...LOADER_RESTING_CELLS]).toEqual([
      false,
      true,
      false,
      false,
      false,
      true,
      false,
      true,
      false,
    ]);
    const markup = renderToStaticMarkup(<ResponseLoadingState createdAt={null} label="Working" />);
    expect((markup.match(/data-lit=""/g) ?? []).length).toBe(3);
  });

  it("keeps the elapsed label short enough that the status line never reflows", () => {
    expect(formatLoadingElapsed(4_200)).toBe("4s");
    expect(formatLoadingElapsed(59_999)).toBe("59s");
    expect(formatLoadingElapsed(0)).toBe("0s");
    expect(formatLoadingElapsed(-50)).toBe("0s");
    expect(formatLoadingElapsed(64_000)).toBe("1m 04s");
    expect(formatLoadingElapsed(3_600_000)).toBe("60m 00s");
  });

  it("renders the meter, shimmer label, and exact elapsed time on one line", () => {
    const markup = renderToStaticMarkup(
      <ResponseLoadingState createdAt={since(4_200)} label="Working" />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-testid="response-loading-state"');
    expect(markup).toContain("bot-status-shimmer");
    expect((markup.match(/animation-delay:/g) ?? []).length).toBe(LOADER_CELL_DELAYS_MS.length);
    expect(markup).toContain('data-testid="response-loading-time">4s<');
  });

  it("carries the elapsed timer past a minute in the same line", () => {
    const markup = renderToStaticMarkup(
      <ResponseLoadingState createdAt={since(64_000)} label="Working" />,
    );

    expect(markup).toContain('data-testid="response-loading-time">1m 04s<');
  });

  it("keeps the meter hooks the one-shot sweep and reduced-motion rules target", () => {
    const markup = renderToStaticMarkup(<ResponseLoadingState createdAt={null} label="Working" />);

    // The sweep and its reduced-motion skip live in index.css on .response-loading-pixel.
    expect(markup).toContain("response-loading-pixel");
  });

  it("omits the timer when the turn start is unknown or unparsable", () => {
    expect(
      renderToStaticMarkup(<ResponseLoadingState createdAt={null} label="Thinking" />),
    ).not.toContain("response-loading-time");
    expect(
      renderToStaticMarkup(<ResponseLoadingState createdAt="not-a-date" label="Thinking" />),
    ).not.toContain("response-loading-time");
  });

  it("owns exactly one live region so a wrapper never nests another", () => {
    const markup = renderToStaticMarkup(
      <ResponseLoadingState createdAt={since(1_000)} label="Working" />,
    );

    expect((markup.match(/role="status"/g) ?? []).length).toBe(1);
    expect(markup).not.toContain("aria-live");
  });
});
