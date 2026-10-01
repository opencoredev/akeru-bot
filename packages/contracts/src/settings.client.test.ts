import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ClientSettingsSchema } from "./settings.ts";
import { decodeClientSettings, decodeClientSettingsPatch } from "./settings.test-support.ts";

describe("ClientSettings word wrap", () => {
  it("defaults word wrap on", () => {
    expect(decodeClientSettings({}).wordWrap).toBe(true);
  });

  it("ignores obsolete wrapping preferences", () => {
    const decoded = decodeClientSettings({
      chatWordWrap: false,
      diffWordWrap: false,
    });

    expect(decoded.wordWrap).toBe(true);
    expect(decoded).not.toHaveProperty("chatWordWrap");
    expect(decoded).not.toHaveProperty("diffWordWrap");
  });
});

describe("ClientSettings glass opacity", () => {
  it("defaults to a readable translucent surface", () => {
    expect(decodeClientSettings({}).glassOpacity).toBe(80);
  });

  it.each([39, 101, 72.5])("rejects an invalid glass opacity: %s", (value) => {
    expect(() => decodeClientSettings({ glassOpacity: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ glassOpacity: value })).toThrow();
  });

  it.each([40, 75, 100])("accepts a glass opacity within the supported range: %s", (value) => {
    expect(decodeClientSettings({ glassOpacity: value }).glassOpacity).toBe(value);
    expect(decodeClientSettingsPatch({ glassOpacity: value }).glassOpacity).toBe(value);
  });
});

describe("ClientSettings appearance contrast", () => {
  it("defaults to the theme's original contrast", () => {
    expect(decodeClientSettings({}).appearanceContrast).toBe(100);
  });

  it.each([49, 201, 92.5])("rejects an invalid appearance contrast: %s", (value) => {
    expect(() => decodeClientSettings({ appearanceContrast: value })).toThrow();
    expect(() => decodeClientSettingsPatch({ appearanceContrast: value })).toThrow();
  });

  it.each([50, 100, 150, 200])("accepts an appearance contrast in range: %s", (value) => {
    expect(decodeClientSettings({ appearanceContrast: value }).appearanceContrast).toBe(value);
    expect(decodeClientSettingsPatch({ appearanceContrast: value }).appearanceContrast).toBe(value);
  });
});

describe("ClientSettings quit confirmation", () => {
  const encodeClientSettings = Schema.encodeSync(ClientSettingsSchema);

  it("defaults to hold and accepts each confirmation mode", () => {
    expect(decodeClientSettings({}).confirmQuit).toBe("hold");

    for (const mode of ["direct", "hold", "double-click"] as const) {
      expect(decodeClientSettings({ confirmQuit: mode }).confirmQuit).toBe(mode);
      expect(decodeClientSettingsPatch({ confirmQuit: mode }).confirmQuit).toBe(mode);
      expect(encodeClientSettings(decodeClientSettings({ confirmQuit: mode })).confirmQuit).toBe(
        mode,
      );
    }
  });

  it("migrates persisted booleans to hold or direct", () => {
    expect(decodeClientSettings({ confirmQuit: true }).confirmQuit).toBe("hold");
    expect(decodeClientSettings({ confirmQuit: false }).confirmQuit).toBe("direct");
  });

  it("rejects unsupported confirmation modes", () => {
    expect(() => decodeClientSettings({ confirmQuit: "maybe" })).toThrow();
    expect(() => decodeClientSettingsPatch({ confirmQuit: "maybe" })).toThrow();
    expect(() => decodeClientSettingsPatch({ confirmQuit: true })).toThrow();
  });
});

describe("ClientSettings environment identification", () => {
  it("defaults to artwork and accepts each presentation mode", () => {
    expect(decodeClientSettings({}).environmentIdentificationMode).toBe("artwork");

    for (const mode of ["artwork", "pill", "none"] as const) {
      expect(
        decodeClientSettingsPatch({ environmentIdentificationMode: mode })
          .environmentIdentificationMode,
      ).toBe(mode);
    }
  });

  it("rejects unsupported presentation modes", () => {
    expect(() => decodeClientSettings({ environmentIdentificationMode: "badge" })).toThrow();
    expect(() => decodeClientSettingsPatch({ environmentIdentificationMode: "badge" })).toThrow();
  });
});

describe("ClientSettings sidebar", () => {
  it("drops the retired sidebar keys", () => {
    const decoded = decodeClientSettings({
      sidebarV2Enabled: false,
      sidebarV2ConfiguredByUser: true,
      legacySidebarEnabled: true,
    });

    expect(decoded).not.toHaveProperty("sidebarV2Enabled");
    expect(decoded).not.toHaveProperty("sidebarV2ConfiguredByUser");
    expect(decoded).not.toHaveProperty("legacySidebarEnabled");
    expect(decodeClientSettingsPatch({ legacySidebarEnabled: true })).not.toHaveProperty(
      "legacySidebarEnabled",
    );
  });

  it("drops retired auto-settle settings", () => {
    const settings = decodeClientSettings({
      sidebarAutoSettleAfterDays: 3,
      sidebarAutoSettleOnMerge: true,
    });

    expect(settings).not.toHaveProperty("sidebarAutoSettleAfterDays");
    expect(settings).not.toHaveProperty("sidebarAutoSettleOnMerge");
  });

  it("drops the retired floating preview setting", () => {
    expect(decodeClientSettings({ browserAutoShowFloatingPreview: false })).not.toHaveProperty(
      "browserAutoShowFloatingPreview",
    );
  });
});

describe("ClientSettings plan mode", () => {
  it("drops the retired plan mode flag from settings files and patches", () => {
    expect(decodeClientSettings({ planModeEnabled: true })).not.toHaveProperty("planModeEnabled");
    expect(decodeClientSettingsPatch({ planModeEnabled: true })).not.toHaveProperty(
      "planModeEnabled",
    );
  });
});
