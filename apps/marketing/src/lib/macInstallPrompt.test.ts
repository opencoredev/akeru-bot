import { describe, expect, it } from "vite-plus/test";

import {
  MAC_INSTALL_PROMPT,
  MAC_INSTALL_SUCCESS,
  checksumForAsset,
  macInstallSuccess,
  selectMacInstallAsset,
} from "./macInstallPrompt";

const assets = [
  { name: "Akeru-Bot-1.0.0-arm64.dmg", browser_download_url: "https://example.test/arm" },
];

describe("macOS install prompt", () => {
  it("uses the exact app name shipped in the DMG", () => {
    expect(MAC_INSTALL_PROMPT).toContain("/Applications/Akeru Bot (Alpha).app");
    expect(MAC_INSTALL_PROMPT).not.toContain("/Applications/Akeru Bot.app");
  });

  it("selects the matching release asset and refuses unavailable architectures", () => {
    expect(selectMacInstallAsset("arm64", assets)).toBe(assets[0]);
    expect(selectMacInstallAsset("x86_64", assets)).toBeNull();
    expect(selectMacInstallAsset("powerpc", assets)).toBeNull();
  });

  it("requires an exact SHA256SUMS entry for the selected asset", () => {
    const digest = "a".repeat(64);
    const checksums = `${digest}  Akeru-Bot-1.0.0-arm64.dmg\n${"b".repeat(64)}  other.dmg`;

    expect(checksumForAsset(checksums, assets[0]!.name)).toBe(digest);
    expect(checksumForAsset(checksums, "Akeru-Bot-1.0.0-x64.dmg")).toBeNull();
    expect(checksumForAsset(`not-a-hash  ${assets[0]!.name}`, assets[0]!.name)).toBeNull();
  });

  it("reports success only after every verification gate passes", () => {
    const verified = {
      checksumVerified: true,
      installed: true,
      launched: true,
      appVisible: true,
    };

    expect(macInstallSuccess(verified)).toBe(MAC_INSTALL_SUCCESS);
    for (const gate of Object.keys(verified) as Array<keyof typeof verified>) {
      expect(macInstallSuccess({ ...verified, [gate]: false })).toBeNull();
    }
  });
});
