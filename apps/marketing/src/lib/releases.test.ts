import * as NodeAssert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  blockDownloadUntilResolved,
  detectDownloadTarget,
  RELEASES_URL,
  requiresUnsignedInstall,
  resolveAssetDownload,
  selectReleaseAsset,
  type Release,
} from "./releases";

const release = {
  tag_name: "v1.2.3",
  html_url: "https://github.com/opencoredev/akeru-bot/releases/tag/v1.2.3",
  assets: [
    {
      name: "Akeru-Bot-1.2.3-arm64.dmg",
      browser_download_url: "https://downloads.example/mac",
    },
    {
      name: "Akeru-Bot-1.2.3-x64.exe",
      browser_download_url: "https://downloads.example/windows",
    },
    {
      name: "Akeru-Bot-1.2.3-x64.AppImage",
      browser_download_url: "https://downloads.example/linux",
    },
  ],
} satisfies Release;

class DownloadLinkStub extends EventTarget {
  href = RELEASES_URL;
  attributes = new Map<string, string>();

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === "href") this.href = "";
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}

describe("release downloads", () => {
  it("selects safe assets for supported platforms", () => {
    const cases = [
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "arm64.dmg", "mac"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "x64.exe", "win"],
      ["Mozilla/5.0 (X11; Linux x86_64)", "x64.AppImage", "linux"],
    ] as const;

    for (const [userAgent, suffix, os] of cases) {
      const target = detectDownloadTarget(userAgent);
      NodeAssert.equal(target?.os, os);
      NodeAssert.equal(target?.assetSuffix, suffix);
      NodeAssert.equal(
        selectReleaseAsset(release, suffix)?.browser_download_url,
        release.assets.find((asset) => asset.name.endsWith(suffix))?.browser_download_url,
      );
    }
  });

  it("does not advertise macOS Intel or unknown systems", () => {
    NodeAssert.equal(detectDownloadTarget("Macintosh; Intel Mac OS X")?.assetSuffix, "arm64.dmg");
    NodeAssert.equal(detectDownloadTarget("Mozilla/5.0 (Android 16)"), null);
  });

  it("blocks a fast click until the primary download resolves", () => {
    const link = new DownloadLinkStub();
    link.href = "https://wrong.example";
    const resolve = blockDownloadUntilResolved(link);
    const pendingClick = new Event("click", { cancelable: true });
    link.dispatchEvent(pendingClick);
    NodeAssert.equal(pendingClick.defaultPrevented, true);
    NodeAssert.equal(link.attributes.get("aria-disabled"), "true");

    resolve("https://downloads.example/mac");
    const readyClick = new Event("click", { cancelable: true });
    link.dispatchEvent(readyClick);
    NodeAssert.equal(readyClick.defaultPrevented, false);
    NodeAssert.equal(link.href, "https://downloads.example/mac");
  });

  it("uses one resolver for direct assets and fallback links", async () => {
    let finishRelease!: (value: Release) => void;
    const pendingRelease = new Promise<Release>((resolve) => {
      finishRelease = resolve;
    });
    const link = new DownloadLinkStub();
    const resolving = resolveAssetDownload(link, "x64.exe", pendingRelease);
    const pendingClick = new Event("click", { cancelable: true });
    link.dispatchEvent(pendingClick);
    NodeAssert.equal(pendingClick.defaultPrevented, true);
    NodeAssert.equal(link.attributes.get("aria-disabled"), "true");

    finishRelease(release);
    NodeAssert.equal(await resolving, release.assets[1]);
    NodeAssert.equal(link.href, "https://downloads.example/windows");

    const fallback = new DownloadLinkStub();
    NodeAssert.equal(
      await resolveAssetDownload(fallback, "x64.exe", Promise.reject(new Error("offline"))),
      null,
    );
    NodeAssert.equal(fallback.href, RELEASES_URL);
    NodeAssert.equal(fallback.attributes.has("aria-disabled"), false);
  });

  it("accepts only the exact asset for the stable tag", () => {
    NodeAssert.equal(selectReleaseAsset(release, "arm64.dmg"), release.assets[0]);
    NodeAssert.equal(
      selectReleaseAsset(
        {
          ...release,
          assets: [{ name: "Akeru-Bot-preview-1.2.3-arm64.dmg", browser_download_url: "bad" }],
        },
        "arm64.dmg",
      ),
      null,
    );
    NodeAssert.equal(selectReleaseAsset({ ...release, tag_name: "preview" }, "arm64.dmg"), null);
  });

  it("prompts for every unsigned desktop artifact", () => {
    NodeAssert.equal(requiresUnsignedInstall("arm64.dmg"), true);
    NodeAssert.equal(requiresUnsignedInstall("x64.exe"), true);
    NodeAssert.equal(requiresUnsignedInstall("x64.AppImage"), true);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function releaseResponse(data: unknown = release): Response {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

describe("bounded shared release requests", () => {
  const cache = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => cache.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => cache.set(key, value)),
    removeItem: vi.fn((key: string) => cache.delete(key)),
  };
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.resetAllMocks();
    cache.clear();
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares a single flight across independently resolved links and caches success", async () => {
    const response = deferred<Response>();
    fetchMock.mockReturnValue(response.promise);
    const { fetchLatestRelease, resolveAssetDownload } = await import("./releases");
    const first = fetchLatestRelease();
    expect(fetchLatestRelease()).toBe(first);
    const mac = new DownloadLinkStub();
    const windows = new DownloadLinkStub();
    const downloads = [
      resolveAssetDownload(mac, "arm64.dmg"),
      resolveAssetDownload(windows, "x64.exe"),
    ];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    response.resolve(releaseResponse());
    await Promise.all(downloads);
    expect(await first).toEqual(release);
    expect(mac.href).toBe(release.assets[0].browser_download_url);
    expect(windows.href).toBe(release.assets[1].browser_download_url);
    expect(await fetchLatestRelease()).toEqual(release);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
      "akeru-latest-release",
      JSON.stringify(release),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])(
    "aborts stalled %s and restores every fallback at the shared deadline",
    async (stage) => {
      const stalled = deferred<Response>();
      const body = deferred<Release>();
      fetchMock.mockReturnValue(
        stage === "headers"
          ? stalled.promise
          : Promise.resolve({ ok: true, json: () => body.promise } as Response),
      );
      const { fetchLatestRelease, resolveAssetDownload, RELEASE_REQUEST_TIMEOUT_MS } =
        await import("./releases");
      const cards = [new DownloadLinkStub(), new DownloadLinkStub(), new DownloadLinkStub()];
      const downloads = cards.map((card) => resolveAssetDownload(card, "x64.exe"));
      const request = fetchLatestRelease().catch((error: unknown) => error);
      const signal = fetchMock.mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(RELEASE_REQUEST_TIMEOUT_MS - 1);
      expect(cards.every((card) => card.attributes.get("aria-disabled") === "true")).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(await request).toEqual(new Error("GitHub release request timed out"));
      expect(await Promise.all(downloads)).toEqual([null, null, null]);
      expect(signal?.aborted).toBe(true);
      for (const card of cards) {
        expect(card.href).toBe(RELEASES_URL);
        expect(card.attributes.has("aria-disabled")).toBe(false);
        const click = new Event("click", { cancelable: true });
        card.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(false);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      const retry = deferred<Response>();
      fetchMock.mockReturnValueOnce(retry.promise);
      const retried = fetchLatestRelease();
      stalled.resolve(releaseResponse());
      body.resolve(release);
      await Promise.resolve();
      expect(fetchLatestRelease()).toBe(retried);
      const nextRelease = { ...release, tag_name: "v1.2.4" };
      retry.resolve(releaseResponse(nextRelease));
      expect(await retried).toEqual(nextRelease);
      expect(await fetchLatestRelease()).toEqual(nextRelease);
      expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
        "akeru-latest-release",
        JSON.stringify(nextRelease),
      );
      expect(cards.every((card) => card.href === RELEASES_URL)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["network", "http", "json", "schema"])(
    "does not cache %s failures and permits retry",
    async (failure) => {
      switch (failure) {
        case "network":
          fetchMock.mockRejectedValueOnce(new Error("offline"));
          break;
        case "http":
          fetchMock.mockResolvedValueOnce(new Response("rate limited", { status: 403 }));
          break;
        case "json":
          fetchMock.mockResolvedValueOnce(new Response("not json"));
          break;
        default:
          fetchMock.mockResolvedValueOnce(releaseResponse({ ...release, assets: [null] }));
      }
      const { fetchLatestRelease, resolveAssetDownload } = await import("./releases");
      const link = new DownloadLinkStub();
      expect(await resolveAssetDownload(link, "arm64.dmg")).toBeNull();
      expect(link.href).toBe(RELEASES_URL);
      expect(link.attributes.has("aria-disabled")).toBe(false);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      fetchMock.mockResolvedValueOnce(releaseResponse());
      expect(await fetchLatestRelease()).toEqual(release);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("uses a valid session cache without network work or a deadline", async () => {
    cache.set("akeru-latest-release", JSON.stringify(release));
    const { fetchLatestRelease } = await import("./releases");
    expect(await fetchLatestRelease()).toEqual(release);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["invalid json", JSON.stringify({ tag_name: "preview" })])(
    "replaces invalid session data: %s",
    async (cached) => {
      cache.set("akeru-latest-release", cached);
      fetchMock.mockResolvedValueOnce(releaseResponse());
      const { fetchLatestRelease } = await import("./releases");
      expect(await fetchLatestRelease()).toEqual(release);
      expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith("akeru-latest-release");
      expect(cache.get("akeru-latest-release")).toBe(JSON.stringify(release));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps successful downloads and the memory cache when session storage is denied", async () => {
    storage.getItem.mockImplementation(() => {
      throw new Error("denied");
    });
    storage.setItem.mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    fetchMock.mockResolvedValueOnce(releaseResponse());
    const { fetchLatestRelease, resolveAssetDownload } = await import("./releases");
    const link = new DownloadLinkStub();
    expect(await resolveAssetDownload(link, "arm64.dmg")).toEqual(release.assets[0]);
    expect(link.href).toBe(release.assets[0].browser_download_url);
    expect(await fetchLatestRelease()).toEqual(release);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the releases fallback when a valid release has no matching asset", async () => {
    fetchMock.mockResolvedValueOnce(releaseResponse({ ...release, assets: [] }));
    const { resolveAssetDownload } = await import("./releases");
    const link = new DownloadLinkStub();
    expect(await resolveAssetDownload(link, "arm64.dmg")).toBeNull();
    expect(link.href).toBe(RELEASES_URL);
    expect(link.attributes.has("aria-disabled")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
