// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { LEGACY_SETTINGS_SECTIONS } from "../../settingsDialogStore";

describe("settings pages", () => {
  it("keeps the bot inbox reachable on the Advanced page under its old anchor", () => {
    const pages = NodeFS.readFileSync(new URL("./SettingsPages.tsx", import.meta.url), "utf8");
    const inbox = NodeFS.readFileSync(new URL("./InboxPanel.tsx", import.meta.url), "utf8");
    expect(pages).toContain("<InboxSection />");
    expect(inbox).toContain('id="errors"');
    expect(LEGACY_SETTINGS_SECTIONS.inbox).toEqual({ section: "advanced", targetId: "errors" });
  });
});
