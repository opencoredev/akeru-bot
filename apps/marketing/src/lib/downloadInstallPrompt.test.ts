import { describe, expect, it } from "vite-plus/test";
import {
  MAC_DOWNLOAD_DIALOG_BODY,
  installPromptPlatformForDownload,
} from "./downloadInstallPrompt";

describe("installPromptPlatformForDownload", () => {
  it("shows the install prompt only after resolving a macOS download", () => {
    expect(installPromptPlatformForDownload("mac", true)).toBe("mac");
    expect(installPromptPlatformForDownload("mac", false)).toBeNull();
    expect(installPromptPlatformForDownload("win", true)).toBeNull();
    expect(installPromptPlatformForDownload("linux", true)).toBeNull();
  });

  it("explains why macOS may block the app", () => {
    expect(MAC_DOWNLOAD_DIALOG_BODY).toMatch(/paid Developer Program/);
    expect(MAC_DOWNLOAD_DIALOG_BODY).toMatch(/macOS may block Akeru Bot/);
  });
});
