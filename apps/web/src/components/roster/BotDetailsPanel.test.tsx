// @effect-diagnostics nodeBuiltinImport:off - The route contract reads its source.
import * as NodeFS from "node:fs";

import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  BotDetailsPanel,
  BotOverview,
  parseBotUsageCapInput,
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
    // No bot thread yet, so the empty browser preview stays hidden.
    expect(markup).not.toContain('data-testid="bot-browser-preview"');
    expect(markup).toContain(">Bot</h2>");
    expect(markup).toContain("Akeru");
    expect(markup).toContain("Research");
    expect(markup).toContain("Finds evidence and explains what matters.");
    expect(markup).toContain("Open bot settings");
    expect(markup).toContain("Personality");
    expect(markup).toContain("Balanced");
    // No providers are loaded in this render, so the panel says so plainly.
    expect(markup).toContain("No provider ready");
    expect(markup).not.toContain("App default");
    expect(markup).toContain("Sandbox");
    expect(markup).not.toContain('aria-label="Bot name"');
    expect(markup).not.toContain('aria-label="Bot description"');
    expect(markup).not.toContain("Token hard stop");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('data-state="closed"');
    expect(markup).toContain('aria-label="Open Akeru bot sidebar"');
    expect(markup).not.toContain("Routines");
    expect(markup).not.toContain("mock data");
    expect(markup).not.toContain("border-b border-border");
  });

  it("keeps an unavailable model on the overview and says why", () => {
    const markup = renderToStaticMarkup(
      <BotOverview
        bot={{ ...bot, engine: { provider: "claudeAgent", model: "claude-fable-5" } }}
        modelUnavailable="Claude is not connected"
        routinePanelRef={createRef<HTMLDivElement>()}
      />,
    );
    expect(markup).toContain("claude-fable-5");
    expect(markup).toContain("Unavailable: Claude is not connected");
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

  it("stores the desktop preference under the bot id", () => {
    const source = NodeFS.readFileSync(new URL("./BotDetailsPanel.tsx", import.meta.url), "utf8");
    expect(source).toContain("`akeru:bot-details-open:${bot.id}`");
    expect(source).toContain("Schema.Boolean");
    expect(source).toContain("setDesktopOpen((open) => !open)");
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
