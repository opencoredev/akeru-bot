import { describe, expect, it, vi } from "vite-plus/test";

import { captureFavicon } from "./FaviconCapture.ts";

import { PNG, SOURCE_PNG_URL, makeWebContents } from "./test-support/FaviconFixtures.ts";

describe("captureFavicon", () => {
  it("ignores output that is not a bounded PNG data URL", async () => {
    const { webContents } = makeWebContents({
      rasterize: async () => "data:image/svg+xml;base64,c3Zn",
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [SOURCE_PNG_URL],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
  });

  it("waits for physical rasterization settlement after a logical timeout", async () => {
    vi.useFakeTimers();

    try {
      let resolveOld!: (value: unknown) => void;
      let executions = 0;

      const { webContents } = makeWebContents({
        rasterize: () => {
          executions += 1;

          return executions === 1
            ? new Promise((resolve) => {
                resolveOld = resolve;
              })
            : Promise.resolve(PNG);
        },
      });

      const input = {
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [SOURCE_PNG_URL],
        signal: new AbortController().signal,
      };

      const timedOut = captureFavicon(input);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await timedOut).toEqual({ kind: "timed-out" });

      const newer = captureFavicon(input);
      await Promise.resolve();
      expect(executions).toBe(1);
      resolveOld(PNG);
      expect(await newer).toEqual({ kind: "captured", dataUrl: PNG });
      expect(executions).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends candidate fallback after a rasterization timeout", async () => {
    vi.useFakeTimers();

    try {
      let resolveRasterization!: (value: unknown) => void;

      const { webContents, fetch, executeJavaScriptInIsolatedWorld } = makeWebContents({
        rasterize: () =>
          new Promise((resolve) => {
            resolveRasterization = resolve;
          }),
      });

      const capture = captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/first.png", "https://example.com/second.png"],
        signal: new AbortController().signal,
      });

      await vi.advanceTimersByTimeAsync(1_001);

      expect(await capture).toEqual({ kind: "timed-out" });
      expect(fetch).toHaveBeenCalledOnce();
      expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
      resolveRasterization(PNG);
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces queued rasterizations so only the latest pending capture launches", async () => {
    let resolveFirst!: (value: unknown) => void;
    let executions = 0;

    const { webContents } = makeWebContents({
      rasterize: () => {
        executions += 1;

        return executions === 1
          ? new Promise((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve(PNG);
      },
    });

    const input = {
      webContents,
      pageUrl: "https://example.com/page",
      candidates: [SOURCE_PNG_URL],
      signal: new AbortController().signal,
    };

    const first = captureFavicon(input);
    const superseded = captureFavicon(input);
    const newest = captureFavicon(input);

    expect(executions).toBe(1);
    resolveFirst(PNG);
    expect(await first).toEqual({ kind: "captured", dataUrl: PNG });
    expect(await superseded).toEqual({ kind: "none" });
    expect(await newest).toEqual({ kind: "captured", dataUrl: PNG });
    expect(executions).toBe(2);
  });
});
