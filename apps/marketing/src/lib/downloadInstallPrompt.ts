export const MAC_CURL_INSTALL_COMMAND =
  't=$(curl -fsSL https://api.github.com/repos/opencoredev/akeru-bot/releases/latest | sed -n \'s/.*"tag_name":[[:space:]]*"\\(v[0-9][^"]*\\)".*/\\1/p\' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Akeru Bot release." >&2; (exit 1); else f=$(mktemp /tmp/akeru-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/opencoredev/akeru-bot/$t/scripts/install-macos.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/akeru-install-none}"; (exit $rc); fi';

export const MAC_DOWNLOAD_DIALOG_TITLE = "Install with one command, not the browser";

export const MAC_DOWNLOAD_DIALOG_BODY =
  "Safari and Chrome quarantine unsigned Mac apps, so Gatekeeper says Akeru Bot is damaged. Paste this one-liner in Terminal. It resolves the latest stable release, downloads that release's installer, checks the DMG against SHA256SUMS, then installs.";

export const WIN_POWERSHELL_INSTALL_COMMAND =
  '$t = (Invoke-RestMethod https://api.github.com/repos/opencoredev/akeru-bot/releases/latest -ErrorAction Stop).tag_name; if ($t -match \'^v\\d+\\.\\d+\\.\\d+$\') { $f = Join-Path $env:TEMP $("akeru-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/opencoredev/akeru-bot/$t/scripts/install-windows.ps1" -OutFile $f -ErrorAction Stop; try { & $f -Tag $t } finally { Remove-Item $f } } else { throw "Could not resolve the latest Akeru Bot release." }';

export const WIN_DOWNLOAD_DIALOG_TITLE = "Install with one command in PowerShell";

export const WIN_DOWNLOAD_DIALOG_BODY =
  "Paste this one-liner in PowerShell. It resolves the latest stable release, downloads that release's installer, checks the exe against SHA256SUMS, then runs it.";

export const LINUX_CURL_INSTALL_COMMAND =
  't=$(curl -fsSL https://api.github.com/repos/opencoredev/akeru-bot/releases/latest | sed -n \'s/.*"tag_name":[[:space:]]*"\\(v[0-9][^"]*\\)".*/\\1/p\' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Akeru Bot release." >&2; (exit 1); else f=$(mktemp /tmp/akeru-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/opencoredev/akeru-bot/$t/scripts/install-linux.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/akeru-install-none}"; (exit $rc); fi';

export const LINUX_DOWNLOAD_DIALOG_TITLE = "Install with one command in Terminal";

export const LINUX_DOWNLOAD_DIALOG_BODY =
  "Paste this one-liner in Terminal. It resolves the latest stable release, downloads that release's installer, checks the AppImage against SHA256SUMS, then installs.";

export function installPromptPlatformForDownload(
  platform: string | undefined,
  resolvedAsset: boolean,
): "mac" | "win" | "linux" | null {
  if (!resolvedAsset) return null;
  return platform === "mac" || platform === "win" || platform === "linux" ? platform : null;
}
