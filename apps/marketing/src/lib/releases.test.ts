import { assert, describe, it } from "@effect/vitest";

import {
  blockDownloadUntilResolved,
  detectDownloadTarget,
  RELEASES_URL,
  requiresUnsignedInstall,
  resolveDownloadUrl,
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
  it("selects safe assets for supported platforms", async () => {
    const cases = [
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "arm64.dmg", "mac"],
      ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "x64.exe", "win"],
      ["Mozilla/5.0 (X11; Linux x86_64)", "x64.AppImage", "linux"],
    ] as const;

    for (const [userAgent, suffix, os] of cases) {
      const target = detectDownloadTarget(userAgent);
      assert.equal(target?.os, os);
      assert.equal(target?.assetSuffix, suffix);
      assert.equal(
        await resolveDownloadUrl(target!, Promise.resolve(release)),
        selectReleaseAsset(release.assets, suffix)?.browser_download_url,
      );
    }
  });

  it("does not advertise macOS Intel or unknown systems", () => {
    assert.equal(detectDownloadTarget("Macintosh; Intel Mac OS X").assetSuffix, "arm64.dmg");
    assert.isNull(detectDownloadTarget("Mozilla/5.0 (Android 16)"));
  });

  it("falls back to all downloads for a missing asset or API failure", async () => {
    const windows = detectDownloadTarget("Windows NT 10.0")!;
    assert.equal(
      await resolveDownloadUrl(windows, Promise.resolve({ ...release, assets: [] })),
      RELEASES_URL,
    );
    assert.equal(await resolveDownloadUrl(windows, Promise.reject(new Error("offline"))), RELEASES_URL);
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
    assert.isTrue(pendingClick.defaultPrevented);
    assert.equal(link.attributes.get("aria-disabled"), "true");

    resolve("https://downloads.example/mac");
    const readyClick = new Event("click", { cancelable: true });
    link.dispatchEvent(readyClick);
    assert.isFalse(readyClick.defaultPrevented);
    assert.equal(link.href, "https://downloads.example/mac");
  });

  it("prompts only for unsigned Windows and Linux artifacts", () => {
    assert.isFalse(requiresUnsignedInstall("arm64.dmg"));
    assert.isTrue(requiresUnsignedInstall("x64.exe"));
    assert.isTrue(requiresUnsignedInstall("x64.AppImage"));
  });
});
