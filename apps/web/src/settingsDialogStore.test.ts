import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@akeru/contracts";

import {
  clearSettingsTarget,
  closeSettings,
  openSettings,
  settingsSectionFromPathname,
  useSettingsDialogStore,
} from "./settingsDialogStore";

beforeEach(() => {
  closeSettings();
});

describe("settings dialog store", () => {
  it("opens on General when no section is named", () => {
    openSettings();
    expect(useSettingsDialogStore.getState().section).toBe("general");
  });

  it("closes back to no section", () => {
    openSettings("advanced");
    expect(useSettingsDialogStore.getState().section).toBe("advanced");
    expect(useSettingsDialogStore.getState().targetId).toBeNull();
    closeSettings();
    expect(useSettingsDialogStore.getState().section).toBeNull();
    expect(useSettingsDialogStore.getState().targetId).toBeNull();
  });

  it("keeps the Bot channels tab across closing and reopening", () => {
    openSettings("channels");
    useSettingsDialogStore.getState().setChannelProvider("telegram");
    closeSettings();
    openSettings("channels");
    expect(useSettingsDialogStore.getState().channelProvider).toBe("telegram");
  });

  it("clears a handled target without closing its Settings section", () => {
    openSettings("sandbox", "local-execution");
    clearSettingsTarget();

    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "sandbox",
      targetId: null,
    });
  });

  it("keeps the originating environment while navigating Settings", () => {
    const environmentId = EnvironmentId.make("env-secondary");
    openSettings("advanced", "errors", environmentId);
    useSettingsDialogStore.getState().openSettings("providers");

    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "providers",
      environmentId,
    });

    closeSettings();
    expect(useSettingsDialogStore.getState().environmentId).toBeNull();
  });

  it("replaces a stale environment when an entry point names its environment", () => {
    const secondaryEnvironmentId = EnvironmentId.make("env-secondary");
    const primaryEnvironmentId = EnvironmentId.make("env-primary");
    openSettings("advanced", "errors", secondaryEnvironmentId);

    openSettings("providers", null, primaryEnvironmentId);

    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "providers",
      environmentId: primaryEnvironmentId,
    });
  });
});

describe("legacy settings deep links", () => {
  it("maps a known settings path onto its section", () => {
    expect(settingsSectionFromPathname("/settings/connections")).toBe("connections");
    expect(settingsSectionFromPathname("/settings/advanced")).toBe("advanced");
    expect(settingsSectionFromPathname("/settings/channels")).toBe("channels");
    expect(settingsSectionFromPathname("/settings/sandbox")).toBe("sandbox");
    expect(settingsSectionFromPathname("/settings/browser")).toBe("browser");
  });

  it("maps retired sections onto the page that now owns them", () => {
    expect(settingsSectionFromPathname("/settings/inbox")).toBe("advanced");
    expect(settingsSectionFromPathname("/settings/source-control")).toBe("general");
    expect(settingsSectionFromPathname("/settings/errors")).toBe("advanced");
    expect(settingsSectionFromPathname("/settings/voice")).toBe("providers");
    expect(settingsSectionFromPathname("/settings/bots")).toBe("channels");
  });

  it("opens archived chat links on the Archived chats page", () => {
    expect(settingsSectionFromPathname("/settings/archived")).toBe("archived");
  });

  it("maps keybinding links onto the configurable shortcut panel", () => {
    expect(settingsSectionFromPathname("/settings/keybindings")).toBe("keybindings");
  });

  it("falls back to General for the bare path and for removed sections", () => {
    expect(settingsSectionFromPathname("/settings")).toBe("general");
    expect(settingsSectionFromPathname("/settings/")).toBe("general");
    expect(settingsSectionFromPathname("/settings/groups")).toBe("general");
  });
});
