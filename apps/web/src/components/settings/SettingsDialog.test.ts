import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "./SettingsDialog";

describe("settings dialog navigation", () => {
  it("shows Bot channels as a navigation tab", () => {
    expect(SETTINGS_NAV_ITEMS).toContainEqual(
      expect.objectContaining({ section: "channels", label: "Bot channels" }),
    );
  });
});
