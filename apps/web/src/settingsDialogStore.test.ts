import { beforeEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

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
    openSettings("inbox");
    expect(useSettingsDialogStore.getState().section).toBe("inbox");
    expect(useSettingsDialogStore.getState().targetId).toBeNull();
    closeSettings();
    expect(useSettingsDialogStore.getState().section).toBeNull();
    expect(useSettingsDialogStore.getState().targetId).toBeNull();
  });

  it("clears a handled target without closing its Settings section", () => {
    openSettings("general", "local-execution");
    clearSettingsTarget();

    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "general",
      targetId: null,
    });
  });

  it("keeps the originating environment while navigating Settings", () => {
    const environmentId = EnvironmentId.make("env-secondary");
    openSettings("inbox", null, environmentId);
    useSettingsDialogStore.getState().openSettings("voice");

    expect(useSettingsDialogStore.getState()).toMatchObject({
      section: "voice",
      environmentId,
    });

    closeSettings();
    expect(useSettingsDialogStore.getState().environmentId).toBeNull();
  });

  it("replaces a stale environment when an entry point names its environment", () => {
    const secondaryEnvironmentId = EnvironmentId.make("env-secondary");
    const primaryEnvironmentId = EnvironmentId.make("env-primary");
    openSettings("inbox", null, secondaryEnvironmentId);

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
    expect(settingsSectionFromPathname("/settings/inbox")).toBe("inbox");
    expect(settingsSectionFromPathname("/settings/voice")).toBe("voice");
    expect(settingsSectionFromPathname("/settings/browser")).toBe("browser");
    expect(settingsSectionFromPathname("/settings/sandbox")).toBe("sandbox");
    expect(settingsSectionFromPathname("/settings/source-control")).toBe("source-control");
  });

  it("maps keybinding links onto the configurable shortcut panel", () => {
    expect(settingsSectionFromPathname("/settings/keybindings")).toBe("keybindings");
  });

  it("falls back to General for the bare path and for removed sections", () => {
    expect(settingsSectionFromPathname("/settings")).toBe("general");
    expect(settingsSectionFromPathname("/settings/")).toBe("general");
    expect(settingsSectionFromPathname("/settings/archived")).toBe("general");
  });
});
