import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { searchOpenVsxThemes } from "./openVsxThemes";

import { ASSET_ROOT, extensionDetail } from "./openVsxThemes.test-support";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Open VSX themes", () => {
  it("searches theme extensions and keeps only supported open-source licenses", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("/-/search?")) {
        return new Response(
          JSON.stringify({
            extensions: [
              { namespace: "demo", name: "theme" },
              { namespace: "icons", name: "theme" },
              { namespace: "oversized", name: "theme" },
              { namespace: "unlicensed", name: "theme" },
              { namespace: "unavailable", name: "theme" },
              { namespace: "closed", name: "theme" },
              { namespace: "huge", name: "theme" },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.endsWith("/icons/theme")) {
        return new Response(
          JSON.stringify(
            extensionDetail({
              namespace: "icons",
              files: {
                ...extensionDetail().files,
                manifest: `${ASSET_ROOT.replace("demo/theme", "icons/theme")}/package.json`,
              },
            }),
          ),
          { status: 200 },
        );
      }

      if (url.endsWith("/oversized/theme")) {
        return new Response(
          JSON.stringify(
            extensionDetail({
              namespace: "oversized",
              files: {
                ...extensionDetail().files,
                download: `${ASSET_ROOT.replace("demo/theme", "oversized/theme")}/oversized.vsix`,
              },
            }),
          ),
          { status: 200 },
        );
      }

      if (url.endsWith("/unlicensed/theme")) {
        return new Response(
          JSON.stringify(
            extensionDetail({
              namespace: "unlicensed",
              files: {
                ...extensionDetail().files,
                manifest: `${ASSET_ROOT.replace("demo/theme", "unlicensed/theme")}/package.json`,
              },
            }),
          ),
          { status: 200 },
        );
      }

      if (url.endsWith("/unavailable/theme")) {
        return new Response(
          JSON.stringify(
            extensionDetail({
              namespace: "unavailable",
              files: {
                ...extensionDetail().files,
                download: `${ASSET_ROOT.replace("demo/theme", "unavailable/theme")}/unavailable.vsix`,
                manifest: `${ASSET_ROOT.replace("demo/theme", "unavailable/theme")}/package.json`,
              },
            }),
          ),
          { status: 200 },
        );
      }

      if (url.endsWith("/closed/theme")) {
        return new Response(
          JSON.stringify(extensionDetail({ namespace: "closed", license: "All Rights Reserved" })),
          { status: 200 },
        );
      }

      if (url.endsWith("/huge/theme")) {
        return new Response(JSON.stringify({ padding: "x".repeat(256 * 1024) }), { status: 200 });
      }

      if (url.endsWith("/oversized/theme/1.0.0/file/oversized.vsix")) {
        return new Response(null, {
          headers: { "content-length": String(20 * 1024 * 1024 + 1) },
          status: 200,
        });
      }

      if (url.endsWith("/unavailable/theme/1.0.0/file/unavailable.vsix")) {
        return new Response(null, { status: 404 });
      }

      if (url.endsWith(".vsix")) {
        return new Response(null, { headers: { "content-length": "1024" }, status: 200 });
      }

      if (url.endsWith("/icons/theme/1.0.0/file/package.json")) {
        return new Response(JSON.stringify({ contributes: { iconThemes: [{}] } }), { status: 200 });
      }

      if (url.endsWith("/unlicensed/theme/1.0.0/file/package.json")) {
        return new Response(
          JSON.stringify({ contributes: { themes: [{ path: "./theme.json" }] } }),
          { status: 200 },
        );
      }

      if (url.endsWith("/unavailable/theme/1.0.0/file/package.json")) {
        return new Response(
          JSON.stringify({ license: "MIT", contributes: { themes: [{ path: "./theme.json" }] } }),
          { status: 200 },
        );
      }

      if (url.endsWith("/demo/theme/1.0.0/file/package.json")) {
        return new Response(
          JSON.stringify({ license: "MIT", contributes: { themes: [{ path: "./theme.json" }] } }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify(extensionDetail()), { status: 200 });
    });

    vi.stubGlobal("fetch", fetchMock);

    const results = await searchOpenVsxThemes("  dracula  ");

    expect(results).toEqual([
      expect.objectContaining({
        id: "demo.theme",
        name: "Demo Theme",
        publisher: "demo",
        downloadCount: 123456,
        iconUrl: `${ASSET_ROOT}/icon.png`,
        sourceUrl: "https://github.com/demo/theme",
        license: "MIT",
      }),
    ]);
    const searchUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(searchUrl.searchParams.get("query")).toBe("dracula");
    expect(searchUrl.searchParams.get("category")).toBe("Themes");
    expect(searchUrl.searchParams.get("sortBy")).toBe("downloadCount");
    expect(searchUrl.searchParams.get("sortOrder")).toBe("desc");
    expect(searchUrl.searchParams.get("size")).toBe("16");
  });

  it("supports sorting theme searches", async () => {
    const fetchMock = vi.fn(
      async (..._args: unknown[]) =>
        new Response(JSON.stringify({ extensions: [] }), { status: 200 }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await searchOpenVsxThemes("nord", { sortBy: "rating" });

    const searchUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(searchUrl.searchParams.get("sortBy")).toBe("rating");
    expect(searchUrl.searchParams.get("sortOrder")).toBe("desc");
  });

  it("rejects malformed search responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 200 })),
    );

    await expect(searchOpenVsxThemes("nord")).rejects.toThrow(
      "Open VSX returned an unreadable search response.",
    );
  });

  it("reports an unavailable search when every detail request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/-/search?")) {
          return new Response(
            JSON.stringify({ extensions: [{ namespace: "demo", name: "theme" }] }),
            { status: 200 },
          );
        }

        return new Response(null, { status: 429 });
      }),
    );

    await expect(searchOpenVsxThemes("dracula")).rejects.toThrow(
      "Open VSX theme details are unavailable",
    );
  });

  it("reports an unavailable search when every detail response is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/-/search?")) {
          return new Response(
            JSON.stringify({ extensions: [{ namespace: "demo", name: "theme" }] }),
            { status: 200 },
          );
        }

        return new Response("{}", { status: 200 });
      }),
    );

    await expect(searchOpenVsxThemes("dracula")).rejects.toThrow(
      "Open VSX theme details are unavailable",
    );
  });

  it("returns no results when every theme package is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url.includes("/-/search?")) {
          return new Response(
            JSON.stringify({ extensions: [{ namespace: "demo", name: "theme" }] }),
            { status: 200 },
          );
        }

        if (url.endsWith("/demo/theme")) {
          return new Response(JSON.stringify(extensionDetail()), { status: 200 });
        }

        if (init?.method === "HEAD") return new Response(null, { status: 404 });

        return new Response(
          JSON.stringify({ license: "MIT", contributes: { themes: [{ path: "./theme.json" }] } }),
          { status: 200 },
        );
      }),
    );

    await expect(searchOpenVsxThemes("dracula")).resolves.toEqual([]);
  });

  it("times out a stalled search request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      ),
    );

    const search = expect(searchOpenVsxThemes("dracula")).rejects.toThrow(
      "Open VSX took too long to respond",
    );

    await vi.advanceTimersByTimeAsync(10_000);

    await search;
  });
});
