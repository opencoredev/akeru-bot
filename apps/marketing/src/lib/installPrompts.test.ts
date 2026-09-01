import { describe, expect, it } from "vite-plus/test";

import {
  VERIFIED_INSTALL_SUCCESS,
  verifiedInstallSuccess,
  windowsInstallPrompt,
} from "./installPrompts";

describe("Windows install prompt", () => {
  it("reports success only after every verification passes", () => {
    expect(verifiedInstallSuccess({ checksum: true, install: true, launch: true })).toBe(
      VERIFIED_INSTALL_SUCCESS,
    );
    expect(verifiedInstallSuccess({ checksum: false, install: true, launch: true })).toBeNull();
    expect(verifiedInstallSuccess({ checksum: true, install: false, launch: true })).toBeNull();
    expect(verifiedInstallSuccess({ checksum: true, install: true, launch: false })).toBeNull();
  });

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
