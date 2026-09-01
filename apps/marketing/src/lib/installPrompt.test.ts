import { describe, expect, it } from "vite-plus/test";
import { INSTALL_SUCCESS_MESSAGE, installPromptForPlatform } from "./installPrompt";
import { MAC_INSTALL_PROMPT } from "./macInstallPrompt";
import { windowsInstallPrompt } from "./installPrompts";

describe("installPromptForPlatform", () => {
  it("selects the verified prompt for every shipped platform", () => {
    expect(installPromptForPlatform("mac")).toBe(MAC_INSTALL_PROMPT);
    expect(installPromptForPlatform("win")).toBe(windowsInstallPrompt);
    expect(installPromptForPlatform("linux")).toMatch(/x86_64 or amd64/);
  });

  it("selects the verified Linux x64 AppImage prompt", () => {
    const prompt = installPromptForPlatform("linux");

    expect(prompt).not.toBeNull();
    expect(prompt).toMatch(/x86_64 or amd64/);
    expect(prompt).toMatch(/github\.com\/opencoredev\/akeru-bot/);
    expect(prompt).toMatch(/SHA256SUMS to contain that asset's exact filename/);
    expect(prompt).toMatch(/Ask me where to save/);
    expect(prompt).toMatch(/Only after verification, make that AppImage executable/);
  });

  it("refuses unsupported platforms", () => {
    expect(installPromptForPlatform("android")).toBeNull();
  });

  it("gates the exact success sentence on launch verification", () => {
    for (const platform of ["mac", "win", "linux"]) {
      const prompt = installPromptForPlatform(platform)!;
      expect(prompt.split(INSTALL_SUCCESS_MESSAGE)).toHaveLength(2);
      expect(prompt).toMatch(/only after|Only after/);
      expect(prompt).toMatch(/checksum/i);
      expect(prompt).toMatch(/launch/i);
      expect(prompt).toMatch(/process|window/i);
    }
  });
});
