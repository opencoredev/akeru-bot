export const MAC_DOWNLOAD_DIALOG_TITLE = "Akeru Bot isn't signed yet";

export const MAC_DOWNLOAD_DIALOG_BODY =
  "We haven't joined Apple's paid Developer Program yet, so macOS may block Akeru Bot the first time you open it. Copy this prompt to your coding agent. It will verify the app and open it for you.";

export function installPromptPlatformForDownload(
  platform: string | undefined,
  resolvedAsset: boolean,
): "mac" | null {
  return resolvedAsset && platform === "mac" ? "mac" : null;
}
