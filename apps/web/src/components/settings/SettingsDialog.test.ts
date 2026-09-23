import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_GROUPS, SETTINGS_NAV_ITEMS } from "./SettingsDialog";

describe("settings dialog navigation", () => {
  it("shows Bot channels as a navigation tab", () => {
    expect(SETTINGS_NAV_ITEMS).toContainEqual(
      expect.objectContaining({ section: "channels", label: "Bot channels" }),
    );
  });

  it("keeps the rarely-correct sections last", () => {
    expect(SETTINGS_NAV_GROUPS.at(-1)?.label).toBe("Advanced");
    expect(SETTINGS_NAV_GROUPS.at(-1)?.items.map((item) => item.section)).toEqual([
      "source-control",
      "inbox",
      "diagnostics",
    ]);
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
});
