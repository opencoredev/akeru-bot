import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  settingsSectionFromPathname,
  useSettingsDialogStore,
} from "~/settingsDialogStore";
import { SETTINGS_NAV_GROUPS, SETTINGS_NAV_ITEMS, settingsSectionLabel } from "./SettingsDialog";

describe("settings dialog navigation", () => {
  it("lists General first and lands there by default", () => {
    expect(DEFAULT_SETTINGS_SECTION).toBe("general");
    expect(SETTINGS_NAV_GROUPS[0]?.label).toBe("App");
    expect(SETTINGS_NAV_ITEMS[0]?.section).toBe("general");
    expect(settingsSectionFromPathname("/settings")).toBe("general");
    expect(settingsSectionFromPathname("/settings/unknown")).toBe("general");

    useSettingsDialogStore.getState().openSettings();
    expect(useSettingsDialogStore.getState().section).toBe("general");
    useSettingsDialogStore.getState().closeSettings();
  });

  it("shows Channels in the Bots group", () => {
    const bots = SETTINGS_NAV_GROUPS.find((group) => group.label === "Bots");
    expect(bots?.items).toContainEqual(
      expect.objectContaining({ section: "channels", label: "Channels" }),
    );
  });

  it("flattens the groups in visual order without losing or duplicating a section", () => {
    const grouped = SETTINGS_NAV_GROUPS.flatMap((group) => group.items);

    expect(SETTINGS_NAV_ITEMS).toEqual(grouped);
    expect(new Set(SETTINGS_NAV_ITEMS.map((item) => item.section)).size).toBe(
      SETTINGS_NAV_ITEMS.length,
    );
  });

  it("gives every group a label so no row floats without a heading", () => {
    for (const group of SETTINGS_NAV_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it("keeps the nav small and free of coding-agent leftovers", () => {
    const sections = SETTINGS_NAV_ITEMS.map((item) => item.section);
    // Ten pages plus Image generation, which the roadmap added under Bots.
    expect(sections.length).toBeLessThanOrEqual(11);
    expect(new Set(sections).size).toBe(sections.length);
    expect(sections).not.toContain("source-control");
    expect(sections).not.toContain("diagnostics");
  });

  it("labels every page, listed or not", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(settingsSectionLabel(section)).not.toBe(section);
    }
  });
});
