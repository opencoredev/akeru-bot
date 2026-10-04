import { describe, expect, it, vi } from "vite-plus/test";

import { guardUnsignedDownload, UNSIGNED_INSTALL_PROMPT } from "./downloadLinks";

describe("unsigned download guard", () => {
  for (const suffix of ["arm64.dmg", "x64.exe", "x64.AppImage"]) {
    it(`guards unsigned ${suffix} downloads exactly once`, () => {
      const link = new EventTarget();
      const confirm = vi.fn(() => false);
      guardUnsignedDownload(link, suffix, confirm);
      guardUnsignedDownload(link, suffix, confirm);
      const click = new Event("click", { cancelable: true });
      link.dispatchEvent(click);
      const unsigned = suffix !== "arm64.dmg";
      expect(click.defaultPrevented).toBe(unsigned);
      expect(confirm).toHaveBeenCalledTimes(unsigned ? 1 : 0);

      if (unsigned) expect(confirm).toHaveBeenCalledWith(UNSIGNED_INSTALL_PROMPT);
    });
  }

  it("lets the download through once the visitor confirms", () => {
    const link = new EventTarget();
    guardUnsignedDownload(link, "x64.exe", () => true);
    const click = new Event("click", { cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });
});
