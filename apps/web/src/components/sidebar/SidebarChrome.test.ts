// @effect-diagnostics nodeBuiltinImport:off - This integration guard reads related source files.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { formatEnabledPluginStatus } from "./SidebarChrome";

describe("sidebar footer", () => {
  it("describes real enabled state without claiming an account connection", () => {
    expect(formatEnabledPluginStatus(0)).toBe("No plugins enabled");
    expect(formatEnabledPluginStatus(1)).toBe("1 plugin enabled");
    expect(formatEnabledPluginStatus(3)).toBe("3 plugins enabled");
  });

  it("keeps the error inbox in Settings instead of the sidebar", () => {
    const source = NodeFS.readFileSync(new URL("./SidebarChrome.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("SidebarInboxSummary");
    expect(source).not.toContain('openSettings("inbox")');
  });

  it("shows the verified remote-access account identity when Clerk is configured", () => {
    const source = NodeFS.readFileSync(
      new URL("../clerk/T3ConnectSidebarSignIn.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("showName");
    expect(source).toContain("Sign in for remote access");
  });

  it("keeps the roster scrollable from touch gestures that start on a bot row", () => {
    const source = NodeFS.readFileSync(
      new URL("../roster/BotRosterSidebar.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("touch-pan-y");
    expect(source).not.toContain("touch-none");
  });

  it("keeps short plugin dialogs and the footer independently scrollable", () => {
    const sidebarSource = NodeFS.readFileSync(
      new URL("./SidebarChrome.tsx", import.meta.url),
      "utf8",
    );
    const pluginsSource = NodeFS.readFileSync(
      new URL("../plugins/PluginsDialog.tsx", import.meta.url),
      "utf8",
    );

    expect(sidebarSource).toContain("overflow-y-auto overscroll-contain");
    expect(pluginsSource).toContain("PLUGIN_DIRECTORY_HEADER_CLASS_NAME");
    expect(pluginsSource).toContain('<DialogPanel className="space-y-4 px-6 py-5">');
  });
});
