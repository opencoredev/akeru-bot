import { describe, expect, it, vi } from "vite-plus/test";

import {
  MAX_FAVICON_CANDIDATES,
  MAX_FAVICON_RESPONSE_BYTES,
  captureFavicon,
  selectFaviconCandidates,
} from "./FaviconCapture.ts";

import {
  PNG,
  SOURCE_PNG,
  SOURCE_PNG_URL,
  makeWebContents,
} from "./test-support/FaviconFixtures.ts";

describe("selectFaviconCandidates", () => {
  it("filters and deduplicates before applying the candidate cap", () => {
    const valid = Array.from(
      { length: MAX_FAVICON_CANDIDATES + 2 },
      (_, index) => `https://example.com/favicon-${index}.png`,
    );

    expect(
      selectFaviconCandidates([
        ...Array.from({ length: 64 }, () => "javascript:alert(1)"),
        valid[0]!,
        valid[0]!,
        ...valid.slice(1),
      ]),
    ).toEqual(valid.slice(0, MAX_FAVICON_CANDIDATES));
  });

  it("bounds raw candidate scanning independently of the usable-candidate cap", () => {
    const oversizedInvalid = `javascript:${"x".repeat(2_048)}`;
    expect(
      selectFaviconCandidates([
        ...Array.from({ length: 128 }, () => oversizedInvalid),
        "https://example.com/too-late.png",
      ]),
    ).toEqual([]);
  });
});

describe("captureFavicon", () => {
  it.each([
    {
      label: "same-origin",
      pageUrl: "https://example.com/page",
      faviconUrl: "https://example.com/favicon.png",
      credentials: "include",
    },
    {
      label: "cross-origin",
      pageUrl: "https://example.com/page",
      faviconUrl: "https://cdn.example.net/favicon.png",
      credentials: "omit",
    },
  ])("uses the explicit credential policy for $label requests", async (testCase) => {
    const { webContents, fetch } = makeWebContents();

    const result = await captureFavicon({
      webContents,
      pageUrl: testCase.pageUrl,
      candidates: [testCase.faviconUrl],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "captured", dataUrl: PNG });
    expect(fetch).toHaveBeenCalledWith(
      testCase.faviconUrl,
      expect.objectContaining({ credentials: testCase.credentials, redirect: "error" }),
    );
  });

  it("decodes base64 and percent-encoded inline images without fetching", async () => {
    const { webContents, fetch, executeJavaScriptInIsolatedWorld } = makeWebContents();

    const percentEncodedPng = [...SOURCE_PNG]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join("");

    for (const candidate of [SOURCE_PNG_URL, `data:image/png,${percentEncodedPng}`]) {
      expect(
        await captureFavicon({
          webContents,
          pageUrl: "https://example.com/page",
          candidates: [candidate],
          signal: new AbortController().signal,
        }),
      ).toEqual({ kind: "captured", dataUrl: PNG });
    }

    expect(fetch).not.toHaveBeenCalled();
    expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
  });

  it("tries the next candidate after an ordinary rejection", async () => {
    const { webContents, fetch } = makeWebContents({
      fetch: async (url) =>
        url.endsWith("first.png")
          ? new Response(null, { status: 404 })
          : new Response(new Uint8Array(SOURCE_PNG), {
              headers: { "content-type": "image/png" },
            }),
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/first.png", "https://example.com/second.png"],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "captured", dataUrl: PNG });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels a rejected response body before trying the next candidate", async () => {
    const cancel = vi.fn();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });

    const { webContents, fetch } = makeWebContents({
      fetch: async (url) =>
        url.endsWith("first.png")
          ? new Response(body, { status: 404 })
          : new Response(new Uint8Array(SOURCE_PNG), {
              headers: { "content-type": "image/png" },
            }),
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/first.png", "https://example.com/second.png"],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "captured", dataUrl: PNG });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops a pending fetch when its capture is aborted", async () => {
    const controller = new AbortController();

    const { webContents } = makeWebContents({
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });

    const capture = captureFavicon({
      webContents,
      pageUrl: "https://example.com/page",
      candidates: ["https://example.com/favicon.png"],
      signal: controller.signal,
    });

    controller.abort();
    expect(await capture).toEqual({ kind: "none" });
  });

  it("ends candidate fallback when the overall capture deadline expires", async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);

    const { webContents, fetch } = makeWebContents({
      fetch: (url, init) => {
        if (url.endsWith("first.png")) return Promise.resolve(new Response(null, { status: 404 }));

        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      },
    });

    try {
      const capture = captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [
          "https://example.com/first.png",
          "https://example.com/second.png",
          "https://example.com/third.png",
        ],
        signal: new AbortController().signal,
      });

      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      timeoutController.abort(new DOMException("capture timed out", "TimeoutError"));

      expect(await capture).toEqual({ kind: "timed-out" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(timeout).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it("does not publish a rasterization that completes after the capture deadline", async () => {
    const captureTimeoutController = new AbortController();
    const rasterTimeoutController = new AbortController();

    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) =>
        milliseconds === 5_000 ? captureTimeoutController.signal : rasterTimeoutController.signal,
      );

    let resolveRasterization!: (value: unknown) => void;

    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents({
      rasterize: () =>
        new Promise((resolve) => {
          resolveRasterization = resolve;
        }),
    });

    try {
      const capture = captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: [SOURCE_PNG_URL],
        signal: new AbortController().signal,
      });

      await vi.waitFor(() => expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce());
      captureTimeoutController.abort(new DOMException("capture timed out", "TimeoutError"));

      expect(await capture).toEqual({ kind: "timed-out" });
      resolveRasterization(PNG);
    } finally {
      timeout.mockRestore();
    }
  });

  it("cancels a stalled response body when the capture deadline expires", async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const cancel = vi.fn();

    const { webContents } = makeWebContents({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel,
          }),
          { headers: { "content-type": "image/png" } },
        ),
    });

    try {
      const capture = captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/favicon.png"],
        signal: new AbortController().signal,
      });

      timeoutController.abort(new DOMException("capture timed out", "TimeoutError"));

      expect(await capture).toEqual({ kind: "timed-out" });
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });

  it("rejects and cancels an oversized streamed response", async () => {
    const cancel = vi.fn();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_FAVICON_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });

    const { webContents, executeJavaScriptInIsolatedWorld } = makeWebContents({
      fetch: async () => new Response(body, { headers: { "content-type": "image/png" } }),
    });

    expect(
      await captureFavicon({
        webContents,
        pageUrl: "https://example.com/page",
        candidates: ["https://example.com/favicon.png"],
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: "none" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });
});
