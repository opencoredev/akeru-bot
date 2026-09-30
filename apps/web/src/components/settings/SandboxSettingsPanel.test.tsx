import { describe, expect, it, vi } from "vite-plus/test";

const settingsDialog = vi.hoisted(() => ({ environmentId: "environment-a" }));

vi.mock("../../i18n", async () => {
  const { createTranslator } = await import("@akeru/client-runtime/i18n");
  const translator = createTranslator("en");
  return { useI18n: () => ({ ...translator, t: translator.translate }) };
});

vi.mock("../../settingsDialogStore", () => ({
  useSettingsEnvironmentId: () => settingsDialog.environmentId,
}));

import { SandboxSettingsPanel } from "./SandboxSettingsPanel";

describe("SandboxSettingsPanel", () => {
  it("keys provider editor state to the selected environment", () => {
    const first = SandboxSettingsPanel();
    settingsDialog.environmentId = "environment-b";
    const second = SandboxSettingsPanel();

    expect(first.key).toBe("environment-a");
    expect(second.key).toBe("environment-b");
  });
});
