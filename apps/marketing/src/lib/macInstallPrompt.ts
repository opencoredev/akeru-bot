import type { ReleaseAsset } from "./releases";

export const MAC_INSTALL_SUCCESS = "You can open the app now with no issues.";

export const MAC_INSTALL_PROMPT = `Install the latest unsigned macOS release of Akeru Bot from opencoredev/akeru-bot. Use no other repository or download source. Detect the Mac architecture with uname -m before downloading. Continue only for arm64 and stop for x86_64 or every other architecture because the official release supports Apple silicon only. Download the exact Akeru-Bot-<version>-arm64.dmg asset and SHA256SUMS from the same latest stable vX.Y.Z GitHub release. Require an exact checksum entry for the DMG, verify it with shasum -a 256, and stop on a missing or mismatched checksum. Mount the verified DMG and install Akeru Bot.app in /Applications. Ask only for the native macOS administrator confirmation if /Applications requires it. Remove com.apple.quarantine only from the installed /Applications/Akeru Bot.app. Never disable Gatekeeper or change any system-wide security setting. Launch /Applications/Akeru Bot.app and verify that its process or window exists. Say exactly "${MAC_INSTALL_SUCCESS}" only after the checksum, install, launch, and process or window checks all succeed.`;

export function selectMacInstallAsset(
  architecture: string,
  assets: ReadonlyArray<ReleaseAsset>,
): ReleaseAsset | null {
  if (architecture !== "arm64") return null;
  return assets.find((asset) => asset.name.endsWith("-arm64.dmg")) ?? null;
}

export function checksumForAsset(checksums: string, assetName: string): string | null {
  for (const line of checksums.split(/\r?\n/)) {
    const match = /^([a-f\d]{64})[ \t]+\*?(.+)$/i.exec(line);
    if (match?.[2] === assetName) return match[1]?.toLowerCase() ?? null;
  }
  return null;
}

export function macInstallSuccess(input: {
  checksumVerified: boolean;
  installed: boolean;
  launched: boolean;
  appVisible: boolean;
}): string | null {
  return Object.values(input).every(Boolean) ? MAC_INSTALL_SUCCESS : null;
}
