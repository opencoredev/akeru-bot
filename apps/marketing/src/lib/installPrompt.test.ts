import { describe, expect, it } from "bun:test";
import { INSTALL_SUCCESS_MESSAGE, installPromptForPlatform } from "./installPrompt";

describe("installPromptForPlatform", () => {
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
    const prompt = installPromptForPlatform("linux")!;
    const successGate = `Only after launch verification, output exactly: ${INSTALL_SUCCESS_MESSAGE}`;

    expect(prompt.endsWith(successGate)).toBe(true);
    expect(prompt.split(INSTALL_SUCCESS_MESSAGE)).toHaveLength(2);
    expect(prompt).toMatch(/If any step fails, report the failure and do not claim success/);
  });
});
