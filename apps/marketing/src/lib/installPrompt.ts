export const INSTALL_SUCCESS_MESSAGE = "You can open the app now with no issues.";

const LINUX_X64_INSTALL_PROMPT = `Install the latest stable Akeru Bot AppImage for me. Before downloading, require uname -m to return x86_64 or amd64 and stop for every other architecture. Use only the latest release from https://github.com/opencoredev/akeru-bot and download its x86_64 AppImage plus SHA256SUMS. Ask me where to save the AppImage. Require SHA256SUMS to contain that asset's exact filename and require the downloaded file's SHA-256 to match. Stop if the checksum is missing or mismatched. Only after verification, make that AppImage executable. Do not chmod any other file and do not install it system-wide. Launch the verified AppImage, then verify its process or window is running. If any step fails, report the failure and do not claim success. Only after launch verification, output exactly: ${INSTALL_SUCCESS_MESSAGE}`;

export function installPromptForPlatform(platform: string): string | null {
  return platform === "linux" ? LINUX_X64_INSTALL_PROMPT : null;
}
