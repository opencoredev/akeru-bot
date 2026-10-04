import * as NodeAssert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  detectDownloadTarget,
  FALLBACK_VERSION,
  releaseAssetUrl,
  requiresUnsignedInstall,
  resolveAssetDownload,
  selectReleaseAsset,
  upgradeReleaseInfo,
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

// The direct asset URL a page bakes in at build time.
const BAKED_URL = releaseAssetUrl("1.2.2", "x64.exe");

class DownloadLinkStub {
  href = BAKED_URL;
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
    NodeAssert.equal(detectDownloadTarget("Mozilla/5.0 (Linux; Android 16; Pixel 9)"), null);
    NodeAssert.equal(
      detectDownloadTarget("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)"),
      null,
    );
  });

  it("bakes direct asset URLs for the build-time version", () => {
    NodeAssert.equal(
      releaseAssetUrl("0.2.1", "arm64.dmg"),
      "https://github.com/opencoredev/akeru-bot/releases/download/v0.2.1/Akeru-Bot-0.2.1-arm64.dmg",
    );
    NodeAssert.match(FALLBACK_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it("upgrades a baked link only when the latest release has the asset", async () => {
    let finishRelease!: (value: Release) => void;

    const pendingRelease = new Promise<Release>((resolve) => {
      finishRelease = resolve;
    });

    const link = new DownloadLinkStub();
    const resolving = resolveAssetDownload(link, "x64.exe", pendingRelease);
    NodeAssert.equal(link.href, BAKED_URL);

    finishRelease(release);
    NodeAssert.equal(await resolving, release.assets[1]);
    NodeAssert.equal(link.href, "https://downloads.example/windows");

    const offline = new DownloadLinkStub();
    NodeAssert.equal(
      await resolveAssetDownload(offline, "x64.exe", Promise.reject(new Error("offline"))),
      null,
    );
    NodeAssert.equal(offline.href, BAKED_URL);
  });

  it("never moves a baked link back to an older release", async () => {
    const link = new DownloadLinkStub();
    link.href = releaseAssetUrl("1.3.0", "x64.exe");
    NodeAssert.equal(
      await resolveAssetDownload(link, "x64.exe", Promise.resolve(release)),
      release.assets[1],
    );
    NodeAssert.equal(link.href, releaseAssetUrl("1.3.0", "x64.exe"));
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

  it("prompts only for unsigned desktop artifacts", () => {
    NodeAssert.equal(requiresUnsignedInstall("arm64.dmg"), false);
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

function releaseResponse(
  data: Omit<Release, "assets"> & { assets: (Release["assets"][number] | null)[] } = release,
): Response {
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
    "aborts stalled %s and keeps every baked link at the shared deadline",
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
      const request = fetchLatestRelease().catch((cause: unknown) => cause);
      const signal = fetchMock.mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(RELEASE_REQUEST_TIMEOUT_MS - 1);
      expect(cards.every((card) => card.href === BAKED_URL)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(await request).toEqual(new Error("GitHub release request timed out"));
      expect(await Promise.all(downloads)).toEqual([null, null, null]);
      expect(signal?.aborted).toBe(true);
      expect(cards.every((card) => card.href === BAKED_URL)).toBe(true);
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
      expect(cards.every((card) => card.href === BAKED_URL)).toBe(true);
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
      expect(link.href).toBe(BAKED_URL);
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

  it("keeps the baked link when a valid release has no matching asset", async () => {
    fetchMock.mockResolvedValueOnce(releaseResponse({ ...release, assets: [] }));
    const { resolveAssetDownload } = await import("./releases");
    const link = new DownloadLinkStub();
    expect(await resolveAssetDownload(link, "arm64.dmg")).toBeNull();
    expect(link.href).toBe(BAKED_URL);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("release info labels", () => {
  it("moves version text and notes links forward with the downloads", () => {
    const label = { textContent: "1.2.2" };
    const notes = { href: "https://github.com/opencoredev/akeru-bot/releases/tag/v1.2.2" };
    upgradeReleaseInfo(release, [label], [notes]);
    expect(label.textContent).toBe("1.2.3");
    expect(notes.href).toBe(release.html_url);
  });

  it("never moves release info back to an older version", () => {
    const label = { textContent: "1.3.0" };
    const notes = { href: "https://github.com/opencoredev/akeru-bot/releases/tag/v1.3.0" };
    upgradeReleaseInfo(release, [label], [notes]);
    expect(label.textContent).toBe("1.3.0");
    expect(notes.href).toBe("https://github.com/opencoredev/akeru-bot/releases/tag/v1.3.0");
  });
});

describe("build-time release version", () => {
  const fetchMock = vi.fn<typeof fetch>();

  const redirectTo = (location: string | null) =>
    new Response(null, { status: 302, headers: location ? { location } : {} });

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the version from the latest-release redirect once per build", async () => {
    fetchMock.mockResolvedValue(
      redirectTo("https://github.com/opencoredev/akeru-bot/releases/tag/v1.4.0"),
    );
    const { resolveBuildVersion } = await import("./releases");

    expect(await resolveBuildVersion()).toBe("1.4.0");
    expect(await resolveBuildVersion()).toBe("1.4.0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  for (const [name, response] of [
    ["a missing location", () => Promise.resolve(redirectTo(null))],
    [
      "a pre-release tag",
      () =>
        Promise.resolve(
          redirectTo("https://github.com/opencoredev/akeru-bot/releases/tag/v1.4.0-rc.1"),
        ),
    ],
    ["a failed request", () => Promise.reject(new Error("offline"))],
  ] as const) {
    it(`falls back to the pinned version after ${name}`, async () => {
      fetchMock.mockImplementation(response);
      const { resolveBuildVersion } = await import("./releases");

      expect(await resolveBuildVersion()).toBe(FALLBACK_VERSION);
    });
  }
});
