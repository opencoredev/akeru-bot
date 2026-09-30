// @effect-diagnostics nodeBuiltinImport:off - The component contract reads its source.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const read = (file: string) => NodeFS.readFileSync(new URL(file, import.meta.url), "utf8");

describe("bot side sheets", () => {
  it("build memory and channels on the shared sheet", () => {
    for (const file of ["./BotMemorySheet.tsx", "./BotChannelsSheet.tsx"]) {
      const source = read(file);
      expect(source).toContain("<BotSideSheet");
      expect(source).toContain("description=");
      expect(source).not.toContain("SheetPopup");
      expect(source).not.toContain("createPortal");
    }
  });

  it("forces the backdrop so every bot sheet dims the page", () => {
    expect(read("./BotSideSheet.tsx")).toContain("forceBackdrop");
    expect(read("../ui/sheet.tsx")).toContain("forceRender={forceBackdrop}");
  });

  it("shows a friendly empty state when the client cannot manage channels", () => {
    const source = read("./BotChannelsSheet.tsx");
    expect(source).toContain('access === "denied"');
    expect(source).toContain("Channels are managed on the host");
    expect(source).not.toContain("does not have permission");
  });
});
