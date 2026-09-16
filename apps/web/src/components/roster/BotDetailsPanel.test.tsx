// @effect-diagnostics nodeBuiltinImport:off - The route contract reads its source.
import * as NodeFS from "node:fs";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  BotDetailsPanel,
  parseBotUsageCapInput,
  reduceBotDetailsPanelState,
  resolveBotUsageCapForProvider,
} from "./BotDetailsPanel";
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
  it("shows a compact overview that hands settings off to the full page", () => {
    const markup = renderToStaticMarkup(<BotDetailsPanel bot={bot} />);
    expect(markup).toContain("Akeru&#x27;s browser");
    expect(markup).toContain('data-testid="bot-browser-preview"');
    expect(markup).toContain(">Bot</h2>");
    expect(markup).toContain("Akeru");
    expect(markup).toContain("Research");
    expect(markup).toContain("Finds evidence and explains what matters.");
    expect(markup).toContain("Open bot settings");
    expect(markup).toContain("Personality");
    expect(markup).toContain("Balanced");
    expect(markup).toContain("App default");
    expect(markup).toContain("Sandbox");
    expect(markup).not.toContain('aria-label="Bot name"');
    expect(markup).not.toContain('aria-label="Bot description"');
    expect(markup).not.toContain("Token hard stop");
    expect(markup).toContain('aria-label="Collapse Akeru bot sidebar"');
    expect(markup).toContain('aria-label="Open Akeru bot sidebar"');
    expect(markup).toContain("Routines");
    expect(markup).toContain("Routines are not available for this environment.");
    expect(markup).not.toContain("mock data");
    expect(markup).not.toContain("border-b border-border");
    expect(markup).toContain("border-t border-border");
  });

  it("sets, clears, and rejects invalid hard stops", () => {
    expect(parseBotUsageCapInput("50000")).toEqual({
      valid: true,
      value: { unit: "tokens", limit: 50_000 },
    });
    expect(parseBotUsageCapInput(" ")).toEqual({ valid: true, value: null });
    expect(parseBotUsageCapInput("0")).toEqual({ valid: false, value: null });
    expect(parseBotUsageCapInput("1.5")).toEqual({ valid: false, value: null });
  });

  it("clears hard stops for occupancy-only providers", () => {
    expect(resolveBotUsageCapForProvider("50000", "cursor")).toEqual({
      available: false,
      valid: true,
      value: null,
    });
    expect(resolveBotUsageCapForProvider("50000", "grok")).toEqual({
      available: false,
      valid: true,
      value: null,
    });
    expect(resolveBotUsageCapForProvider("50000", "codex")).toEqual({
      available: true,
      valid: true,
      value: { unit: "tokens", limit: 50_000 },
    });
  });

  it("uses the configured right-panel shortcut while open or closed", () => {
    const source = NodeFS.readFileSync(new URL("./BotDetailsPanel.tsx", import.meta.url), "utf8");

    expect(source).toContain('resolveShortcutCommand(event, keybindings) !== "rightPanel.toggle"');
    expect(source).toContain("shortcutLabelForCommand(");
    expect(source).toContain('"rightPanel.toggle"');
    expect(source).toContain('window.addEventListener("keydown", onKeyDown, true)');
    expect(source).toContain("RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY");
  });

  it("keeps model and reasoning controls on the full settings page", () => {
    const panelSource = NodeFS.readFileSync(
      new URL("./BotDetailsPanel.tsx", import.meta.url),
      "utf8",
    );
    const settingsSource = NodeFS.readFileSync(
      new URL("./BotSettingsPage.tsx", import.meta.url),
      "utf8",
    );
    const composerSource = NodeFS.readFileSync(
      new URL("./BotPromptComposer.tsx", import.meta.url),
      "utf8",
    );

    expect(panelSource).not.toContain("<BotModelPicker");
    expect(panelSource).not.toContain("<TraitsPicker");
    expect(settingsSource).toContain("<BotModelPicker");
    expect(settingsSource).toContain("<TraitsPicker");
    expect(composerSource).not.toContain("BotModelPicker");
    expect(composerSource).not.toContain("TraitsPicker");
    expect(composerSource).not.toContain("reasoningPicker");
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
    expect(source).toContain("threadRef={threadRef}");
    expect(source).toContain("onOpenSettings={() =>");
    expect(source).not.toContain("onSaveBot=");
    expect(source).not.toContain("RightPanelTabs");
    expect(source).not.toContain("ThreadTerminalDrawer");
  });
});
