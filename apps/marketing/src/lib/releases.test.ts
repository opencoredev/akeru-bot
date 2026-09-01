import * as NodeAssert from "node:assert/strict";
import { describe, it } from "vite-plus/test";

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
    class Link extends EventTarget {
      href = "https://wrong.example";
      attributes = new Map<string, string>();
      removeAttribute(name: string) {
        this.attributes.delete(name);
        if (name === "href") this.href = "";
      }
      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      }
    }

    const link = new Link();
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
    class Link extends EventTarget {
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

    let finishRelease!: (value: Release) => void;
    const pendingRelease = new Promise<Release>((resolve) => {
      finishRelease = resolve;
    });
    const link = new Link();
    const resolving = resolveAssetDownload(link, "x64.exe", pendingRelease);
    const pendingClick = new Event("click", { cancelable: true });
    link.dispatchEvent(pendingClick);
    NodeAssert.equal(pendingClick.defaultPrevented, true);
    NodeAssert.equal(link.attributes.get("aria-disabled"), "true");

    finishRelease(release);
    NodeAssert.equal(await resolving, release.assets[1]);
    NodeAssert.equal(link.href, "https://downloads.example/windows");

    const fallback = new Link();
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

  it("prompts only for unsigned Windows and Linux artifacts", () => {
    NodeAssert.equal(requiresUnsignedInstall("arm64.dmg"), false);
    NodeAssert.equal(requiresUnsignedInstall("x64.exe"), true);
    NodeAssert.equal(requiresUnsignedInstall("x64.AppImage"), true);
  });
});
