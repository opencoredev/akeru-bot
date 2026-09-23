// @effect-diagnostics nodeBuiltinImport:off - These contracts read their source.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { BOT_IMAGE_PROVIDER_DEFAULT, botImageProviderFromSelectValue } from "./useBotProfileDraft";

function read(relativePath: string): string {
  return NodeFS.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("bot settings page", () => {
  it("is a real route in the generated tree", () => {
    const route = read("../../routes/bots.$botId.settings.tsx");
    const tree = read("../../routeTree.gen.ts");

    expect(route).toContain('createFileRoute("/bots/$botId/settings")');
    expect(route).toContain("<BotSettingsPage");
    expect(route).toContain("Route.useParams().botId");
    // Same auth gate as the other full-page surfaces.
    expect(route).toContain('throw redirect({ to: "/pair", replace: true })');
    expect(tree).toContain("'/bots/$botId/settings'");
    expect(tree).toContain("./routes/bots.$botId.settings");
  });

  it("renders in the main content area with the shared settings primitives", () => {
    const source = read("./BotSettingsPage.tsx");

    expect(source).toContain("<SidebarInset");
    expect(source).toContain("<WorkspacePageHeader");
    expect(source).toContain("<SettingsPageContainer>");
    expect(source).toContain("<SettingsSection");
    expect(source).toContain("<SettingsRow");
    // A cramped modal is exactly what this page replaces.
    expect(source).not.toContain("<DialogPopup");
    expect(source).not.toContain("<SheetPopup");
  });

  it("groups the bot's own settings into named sections", () => {
    const source = read("./BotSettingsPage.tsx");

    expect(source).toContain('title={t("Bot")}');
    expect(source).toContain('title={t("Voice and personality")}');
    expect(source).toContain('title={t("Model")}');
    expect(source).toContain('title={t("Workspace")}');
  });

  it("saves through the shared bot update command", () => {
    const source = read("./BotSettingsPage.tsx");

    expect(source).toContain("useAtomCommand(botEnvironment.update");
    expect(source).toContain("botId: BotId.make(bot.id)");
    // The draft hook builds the payload, so the page cannot invent a shape.
    expect(source).toContain("useBotProfileDraft(bot, onSave)");
    expect(source).toContain('title: t("Could not save bot settings")');
    expect(source).toContain('title: t("Bot settings saved")');
  });

  it("reports saving, saved, and unsaved state from the shared draft", () => {
    const source = read("./BotSettingsPage.tsx");

    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("draft.saved");
    expect(source).toContain("draft.dirty");
    expect(source).toContain("disabled={!draft.canSave || draft.saving}");
    expect(source).toContain('{draft.saving ? t("Saving") : t("Save")}');
  });

  it("protects unsaved settings from app navigation and page unload", () => {
    const source = read("./BotSettingsPage.tsx");

    expect(source).toContain("useBlocker({");
    expect(source).toContain('requestConfirmDialog(t("Discard unsaved bot settings?")');
    expect(source).toContain("enableBeforeUnload: () => draft.dirty");
    expect(source).toContain("disabled: !draft.dirty");
  });

  it("owns the three personality choices and anchors them for deep links", () => {
    const source = read("./BotSettingsPage.tsx");

    expect(source).toContain("<BotPersonalityToneField");
    expect(source).toContain('id="personality"');
    expect(source).toContain("tone={draft.personalityTone}");
    expect(source).toContain("draft.setPersonalityTone(tone)");
    // The baseline promise has to be on the page, not only in this test.
    expect(source).toContain("It is a baseline, not a costume.");
  });

  it("handles a bot that is gone instead of rendering an empty form", () => {
    const source = read("./BotSettingsPage.tsx");
    expect(source).toContain("This bot is no longer available.");
  });
});

describe("bot settings entry points", () => {
  it("opens from the chat header bot identity", () => {
    const source = read("./ActiveBotHeaderChip.tsx");

    expect(source).toContain('to: "/bots/$botId/settings"');
    expect(source).toContain("params: { botId: bot.id }");
    expect(source).toContain("aria-label={`Settings for ${bot.name}`}");
    // The avatar keeps its existing job.
    expect(source).toContain("aria-label={`Change avatar for ${bot.name}`}");
  });

  it("opens from the roster row overflow menu", () => {
    const source = read("./BotRosterSidebar.tsx");

    expect(source).toContain("Bot settings");
    expect(source).toContain("onOpenSettings(bot)");
    expect(source).toContain("const handleOpenBotSettings");
    expect(source).toContain('to: "/bots/$botId/settings"');
    expect(source).toContain("onOpenSettings={handleOpenBotSettings}");
  });

  it("keeps the in-chat panel compact and hands off to the full page", () => {
    const panel = read("./BotDetailsPanel.tsx");
    const route = read("../../routes/_chat.bots.$botId.tsx");

    expect(panel).toContain(
      "botPersonalityToneLabel(canonicalizeBotPersonalityTone(bot.personalityTone), t)",
    );
    expect(panel).toContain("Open bot settings");
    expect(panel).not.toContain("<BotModelPicker");
    expect(panel).not.toContain("<Input");
    expect(panel).not.toContain("BotPersonalityToneField");
    // The panel stays router-free; the route supplies navigation.
    expect(panel).not.toContain("@tanstack/react-router");
    expect(route).toContain("onOpenSettings={() =>");
    expect(route).toContain('to: "/bots/$botId/settings"');
  });

  it("does not add a permanent settings section for bots", () => {
    const settingsStore = read("../../settingsDialogStore.ts");
    const sections = /SETTINGS_SECTIONS = \[(?<body>[\s\S]*?)\] as const;/u.exec(settingsStore)
      ?.groups?.body;

    expect(sections).toBeDefined();
    // Per-bot settings are reached from the bot, not from a global nav entry.
    // The legacy `/settings/bots` deep link still redirects, and stays.
    expect(sections).not.toContain("bots");
    expect(settingsStore).toContain('if (slug === "bots") return "channels";');
  });
});

describe("global settings stay global", () => {
  it("leaves the shared sandbox and browser sharing policy in Settings", () => {
    const panels = read("../settings/SettingsPanels.tsx");
    const botSettings = read("./BotSettingsPage.tsx");

    // This is one environment-wide policy for every bot, not per-bot data.
    expect(panels).toContain("<BotSandboxBrowserSharingSettings");
    expect(panels).toContain("settings.botSandboxBrowserSharing");
    expect(botSettings).not.toContain("botSandboxBrowserSharing");
  });

  it("keeps the app-wide voice toggle out of per-bot settings", () => {
    const voice = read("../settings/VoiceSettings.tsx");
    const botSettings = read("./BotSettingsPage.tsx");

    expect(voice).toContain("settings.voice");
    // The bot owns only its own participation.
    expect(botSettings).toContain("draft.voiceEnabled");
    expect(botSettings).not.toContain("updateSettings(");
  });
});

describe("per-bot image provider", () => {
  it("maps select values to the saved provider and treats unknown values as the default", () => {
    expect(botImageProviderFromSelectValue(BOT_IMAGE_PROVIDER_DEFAULT)).toBeNull();
    expect(botImageProviderFromSelectValue("grok")).toBe("grok");
    expect(botImageProviderFromSelectValue("chatgpt")).toBe("chatgpt");
    expect(botImageProviderFromSelectValue("dall-e")).toBeNull();
  });

  it("keeps image settings out of the chat composer", () => {
    const composer = read("./BotPromptComposer.tsx");
    expect(composer).not.toContain("imageProvider");
    expect(composer).not.toContain("image-generation");
  });
});
