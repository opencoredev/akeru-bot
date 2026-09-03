export const MAC_CURL_INSTALL_COMMAND = [
  "(",
  "set -euo pipefail",
  '[ "$(uname -s)" = Darwin ]',
  '[ "$(uname -m)" = arm64 ]',
  'tmp="$(mktemp -d)"',
  'mnt="$tmp/mnt"',
  `trap 'hdiutil detach "$mnt" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT`,
  'mkdir -p "$mnt"',
  'tag="$(curl -fsSL https://api.github.com/repos/opencoredev/akeru-bot/releases/latest | sed -n \'s/.*"tag_name":[[:space:]]*"\\(v[0-9][^"]*\\)".*/\\1/p\' | head -1)"',
  '[[ "$tag" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]]',
  'version="${tag#v}"',
  'dmg="Akeru-Bot-${version}-arm64.dmg"',
  'base="https://github.com/opencoredev/akeru-bot/releases/download/${tag}"',
  'curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"',
  'curl -fL -o "$tmp/$dmg" "$base/$dmg"',
  'line="$(grep -E "^[a-fA-F0-9]{64}[[:space:]]+\\*?${dmg}\\$" "$tmp/SHA256SUMS")" || exit 1',
  '( cd "$tmp" && printf "%s\\n" "$line" | shasum -a 256 -c - )',
  'hdiutil attach "$tmp/$dmg" -nobrowse -readonly -mountpoint "$mnt"',
  'app="/Applications/Akeru Bot (Alpha).app"',
  'source_app="$mnt/Akeru Bot (Alpha).app"',
  'prepared_app="$tmp/Akeru Bot (Alpha).app"',
  'ditto "$source_app" "$prepared_app"',
  'identifier="$(/usr/libexec/PlistBuddy -c \'Print :CFBundleIdentifier\' "$prepared_app/Contents/Info.plist")"',
  '[ "$identifier" = dev.leodoes.akeru ]',
  'install_id="$(uuidgen)"',
  'new_app="/Applications/.Akeru Bot (Alpha).app.installing.$install_id"',
  'old_app="/Applications/.Akeru Bot (Alpha).app.backup.$install_id"',
  'osascript - "$prepared_app" "$new_app" "$old_app" "$app" <<\'APPLESCRIPT\'',
  "on run argv",
  "  set preparedApp to quoted form of item 1 of argv",
  "  set newApp to quoted form of item 2 of argv",
  "  set oldApp to quoted form of item 3 of argv",
  "  set installedApp to quoted form of item 4 of argv",
  '  do shell script "rm -rf " & newApp & " " & oldApp & " && test ! -e " & newApp & " && test ! -e " & oldApp & " && { ditto " & preparedApp & " " & newApp & " || { rm -rf " & newApp & "; exit 1; }; } && { test ! -e " & installedApp & " || mv " & installedApp & " " & oldApp & "; } && { mv " & newApp & " " & installedApp & " || { test ! -e " & oldApp & " || mv " & oldApp & " " & installedApp & " || { rm -rf " & newApp & "; echo Previous application remains at " & oldApp & " >&2; exit 1; }; rm -rf " & newApp & "; exit 1; }; } && rm -rf " & oldApp with administrator privileges',
  "end run",
  "APPLESCRIPT",
  'xattr -d com.apple.quarantine "$app" 2>/dev/null || true',
  'open "$app"',
  ")",
].join("\n");

export const MAC_DOWNLOAD_DIALOG_TITLE = "Install from Terminal, not the browser";

export const MAC_DOWNLOAD_DIALOG_BODY =
  "Safari and Chrome quarantine unsigned Mac apps, so Gatekeeper says Akeru Bot is damaged. That is not a corrupt file. Paste this in Terminal. It downloads the GitHub DMG, checks SHA256SUMS, then installs. curl does not quarantine the download.";

export function installPromptPlatformForDownload(
  platform: string | undefined,
  resolvedAsset: boolean,
): "mac" | null {
  return resolvedAsset && platform === "mac" ? "mac" : null;
}
