import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
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
    openSettings("providers");
    expect(useSettingsDialogStore.getState().section).toBe("providers");
    closeSettings();
    expect(useSettingsDialogStore.getState().section).toBeNull();
  });
});

describe("legacy settings deep links", () => {
  it("maps a known settings path onto its section", () => {
    expect(settingsSectionFromPathname("/settings/connections")).toBe("connections");
    expect(settingsSectionFromPathname("/settings/voice")).toBe("voice");
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
