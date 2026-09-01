// @effect-diagnostics nodeBuiltinImport:off - This integration guard reads the listener source.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

describe("bot roster shortcuts", () => {
  it("passes every documented live UI flag to shortcut resolution", () => {
    const source = NodeFS.readFileSync(new URL("./BotRosterSidebar.tsx", import.meta.url), "utf8");
    const shortcutContext = source.slice(
      source.indexOf("const command = resolveShortcutCommand"),
      source.indexOf("const bot = resolveRosterShortcutBot"),
    );

    expect(shortcutContext).toContain("terminalFocus: isTerminalFocused()");
    expect(shortcutContext).toContain("terminalOpen");
    expect(shortcutContext).toContain("previewFocus: isPreviewFocused()");
    expect(shortcutContext).toContain("previewOpen");
    expect(shortcutContext).toContain("modelPickerOpen: isModelPickerOpen()");
  });
});
