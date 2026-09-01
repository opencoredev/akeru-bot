// @effect-diagnostics nodeBuiltinImport:off - The route contract reads its source.
import * as NodeFS from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BotDetailsPanel, reduceBotDetailsPanelState } from "./BotDetailsPanel";
import type { Bot } from "./types";

const bot: Bot = {
  id: "bot-akeru",
  name: "Akeru",
  title: "Generalist",
  label: "Research",
  description: "Finds evidence and explains what matters.",
  disabledMcpServerIds: [],
  avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
  engine: null,
  sandbox: null,
  runtimeMode: "full-access",
  usageCap: null,
  voiceEnabled: false,
  groupId: null,
  pinned: false,
  archivedAt: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

describe("BotDetailsPanel", () => {
  it("shows the per-bot profile editor with simple panel chrome", () => {
    const markup = renderToStaticMarkup(<BotDetailsPanel bot={bot} />);
    expect(markup).toContain(">Settings</h2>");
    expect(markup).toContain('aria-label="Change bot avatar"');
    expect(markup).toContain('aria-label="Bot name"');
    expect(markup).toContain('aria-label="Bot label"');
    expect(markup).toContain('aria-label="Bot description"');
    expect(markup).toContain("Connect a provider");
    expect(markup).toContain(">Sandbox</div>");
    expect(markup).toContain('aria-label="Sandbox provider"');
    expect(markup).toContain('aria-label="Bot usage"');
    expect(markup).toContain(">Voice calls</span>");
    expect(markup).toContain('aria-label="Enable voice calls for Akeru"');
    expect(markup).toContain('aria-label="Bot usage"');
    expect(markup).toContain(">Memory</div>");
    expect(markup).toContain('aria-label="Manage bot memory"');
    expect(markup).toContain("No conversation yet");
    expect(markup).toContain(">Tools</div>");
    expect(markup).toContain("No workspace tools");
    expect(markup).toContain(">Manage</span>");
    expect(markup).toContain('aria-label="Collapse Akeru bot sidebar"');
    expect(markup).toContain('aria-label="Open Akeru bot sidebar"');
    expect(markup).not.toContain("Routines");
    expect(markup).not.toContain("mock data");
    expect(markup).not.toContain("border-b border-border");
    expect(markup).not.toContain("border-t border-border");
  });

  it("uses the configured right-panel shortcut while open or closed", () => {
    const source = NodeFS.readFileSync(new URL("./BotDetailsPanel.tsx", import.meta.url), "utf8");

    expect(source).toContain('resolveShortcutCommand(event, keybindings) !== "rightPanel.toggle"');
    expect(source).toContain('shortcutLabelForCommand(keybindings, "rightPanel.toggle")');
    expect(source).toContain('window.addEventListener("keydown", onKeyDown, true)');
    expect(source).toContain("RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY");
  });

  it("collapses and reopens desktop without changing the mobile sheet", () => {
    const collapsed = reduceBotDetailsPanelState(
      { desktopOpen: true, mobileOpen: false },
      { type: "toggle-desktop" },
    );
    expect(collapsed).toEqual({ desktopOpen: false, mobileOpen: false });

    expect(reduceBotDetailsPanelState(collapsed, { type: "toggle-desktop" })).toEqual({
      desktopOpen: true,
      mobileOpen: false,
    });
  });

  it("toggles the mobile sheet without changing desktop", () => {
    const opened = reduceBotDetailsPanelState(
      { desktopOpen: false, mobileOpen: false },
      { type: "toggle-mobile" },
    );
    expect(opened).toEqual({ desktopOpen: false, mobileOpen: true });
    expect(reduceBotDetailsPanelState(opened, { type: "toggle-mobile" })).toEqual({
      desktopOpen: false,
      mobileOpen: false,
    });
  });

  it("sets the mobile sheet state without changing desktop", () => {
    expect(
      reduceBotDetailsPanelState(
        { desktopOpen: true, mobileOpen: true },
        { type: "set-mobile", open: false },
      ),
    ).toEqual({ desktopOpen: true, mobileOpen: false });
  });

  it("mounts from the bot route instead of the generic panel", () => {
    const source = NodeFS.readFileSync(
      new URL("../../routes/_chat.bots.$botId.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("<BotDetailsPanel");
    expect(source).toContain("onSaveBot=");
    expect(source).toContain("threadRef={threadRef}");
    expect(source).toContain("voiceEnabled,");
    expect(source).toContain("sandbox,");
    expect(source).toContain("disabledMcpServerIds,");
    expect(source).not.toContain("RightPanelTabs");
    expect(source).not.toContain("ThreadTerminalDrawer");
  });
});
