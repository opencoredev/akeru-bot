import { describe, expect, it } from "vite-plus/test";

import { settingsBreadcrumbLabel } from "./SettingsRoutePage";

describe("settingsBreadcrumbLabel", () => {
  it("matches the nav label instead of title-casing it", () => {
    expect(settingsBreadcrumbLabel("image-generation")).toBe("Image generation");
    expect(settingsBreadcrumbLabel("source-control")).toBe("Source control");
    expect(settingsBreadcrumbLabel("inbox")).toBe("Bot inbox");
  });

  it("translates the nav label", () => {
    const zh: Record<string, string> = { "Bot inbox": "机器人收件箱" };
    expect(settingsBreadcrumbLabel("inbox", (message) => zh[message] ?? message)).toBe(
      "机器人收件箱",
    );
  });

  it("sentence-cases a section the nav does not list", () => {
    expect(settingsBreadcrumbLabel("some-new-pane")).toBe("Some new pane");
  });
});
