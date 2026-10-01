import { describe, expect, it, vi } from "vite-plus/test";

import { resolveDownloadLink, UNSIGNED_INSTALL_PROMPT } from "./downloadLinks";
import { RELEASES_URL, type Release } from "./releases";

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

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
}

const release: Release = {
  tag_name: "v1.2.3",
  html_url: RELEASES_URL,
  assets: ["arm64.dmg", "x64.exe", "x64.AppImage"].map((suffix) => ({
    name: `Akeru-Bot-1.2.3-${suffix}`,
    browser_download_url: `https://downloads.example/${suffix}`,
  })),
};

describe("download link guards", () => {
  for (const suffix of ["arm64.dmg", "x64.exe", "x64.AppImage"]) {
    it(`guards unsigned ${suffix} downloads exactly once`, async () => {
      const link = new DownloadLinkStub();
      const confirm = vi.fn(() => false);
      await resolveDownloadLink(link, suffix, Promise.resolve(release), confirm);
      await resolveDownloadLink(link, suffix, Promise.resolve(release), confirm);
      const click = new Event("click", { cancelable: true });
      link.dispatchEvent(click);
      const unsigned = suffix !== "arm64.dmg";
      expect(click.defaultPrevented).toBe(unsigned);
      expect(confirm).toHaveBeenCalledTimes(unsigned ? 1 : 0);

      if (unsigned) expect(confirm).toHaveBeenCalledWith(UNSIGNED_INSTALL_PROMPT);
      expect(link.href).toBe(`https://downloads.example/${suffix}`);
    });
  }

  for (const failure of ["missing", "rejected"]) {
    it(`does not guard the release fallback after ${failure} assets`, async () => {
      const link = new DownloadLinkStub();
      const confirm = vi.fn(() => false);
      await resolveDownloadLink(link, "x64.exe", Promise.resolve(release), confirm);

      const result =
        failure === "missing"
          ? Promise.resolve({ ...release, assets: [] })
          : Promise.reject(new Error("offline"));

      expect(await resolveDownloadLink(link, "x64.exe", result, confirm)).toBeNull();
      const click = new Event("click", { cancelable: true });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
      expect(link.href).toBe(RELEASES_URL);
    });
  }

  it("guards a resolved card without waiting for a slow sibling", async () => {
    const slowLink = new DownloadLinkStub();
    const readyLink = new DownloadLinkStub();
    let finishSlow: (release: Release) => void = () => {};

    const slowRelease = new Promise<Release>((resolve) => {
      finishSlow = resolve;
    });

    const slowResolution = resolveDownloadLink(slowLink, "x64.exe", slowRelease, () => false);
    await resolveDownloadLink(readyLink, "x64.exe", Promise.resolve(release), () => false);
    const readyClick = new Event("click", { cancelable: true });
    readyLink.dispatchEvent(readyClick);
    expect(readyClick.defaultPrevented).toBe(true);
    expect(slowLink.getAttribute("aria-disabled")).toBe("true");
    finishSlow(release);
    await slowResolution;
  });
});
