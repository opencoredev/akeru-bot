import { describe, expect, it } from "vite-plus/test";

import { windowsInstallPrompt } from "./installPrompts";

describe("Windows install prompt", () => {
  it("pins the official source and preserves Windows security controls", () => {
    expect(windowsInstallPrompt).toContain("opencoredev/akeru-bot");
    expect(windowsInstallPrompt).toContain("SHA256SUMS");
    expect(windowsInstallPrompt).toContain("Refuse ARM64");
    expect(windowsInstallPrompt).toContain("Akeru-Bot-<version>-x64.exe");
    expect(windowsInstallPrompt).toContain("Unblock-File");
    expect(windowsInstallPrompt).toContain("Do not disable or change SmartScreen");
    expect(windowsInstallPrompt.endsWith("all succeed.")).toBe(true);
  });
});
