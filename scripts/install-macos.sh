#!/usr/bin/env bash
#
# One-line macOS installer for Akeru Bot (Apple Silicon).
#
#   t=$(curl -fsSL https://api.github.com/repos/opencoredev/akeru-bot/releases/latest | sed -n 's/.*"tag_name":[[:space:]]*"\(v[0-9][^"]*\)".*/\1/p' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Akeru Bot release." >&2; (exit 1); else f=$(mktemp /tmp/akeru-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/opencoredev/akeru-bot/$t/scripts/install-macos.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/akeru-install-none}"; (exit $rc); fi
#   bash install-macos.sh --tag v1.2.3
#
# Downloads the GitHub DMG for the latest stable tag (or --tag), checks
# SHA256SUMS, then installs atomically with backup + rollback.

set -euo pipefail

tag=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      if [ "$#" -lt 2 ]; then
        echo "install-macos.sh: --tag requires a value (vX.Y.Z)" >&2
        exit 1
      fi
      tag="$2"
      shift 2
      ;;
    --tag=*)
      tag="${1#--tag=}"
      shift
      ;;
    -h|--help)
      echo "usage: install-macos.sh [--tag vX.Y.Z]"
      exit 0
      ;;
    *)
      echo "install-macos.sh: unknown argument: $1" >&2
      echo "usage: install-macos.sh [--tag vX.Y.Z]" >&2
      exit 1
      ;;
  esac
done

[ "$(uname -s)" = Darwin ]
[ "$(uname -m)" = arm64 ]

tmp="$(mktemp -d)"
mnt="$tmp/mnt"
trap 'hdiutil detach "$mnt" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
mkdir -p "$mnt"

if [ -z "$tag" ]; then
  tag="$(curl -fsSL https://api.github.com/repos/opencoredev/akeru-bot/releases/latest | sed -n 's/.*"tag_name":[[:space:]]*"\(v[0-9][^"]*\)".*/\1/p' | head -1)"
fi
[[ "$tag" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]]

version="${tag#v}"
echo "Installing Akeru Bot $tag for macOS (arm64)..."

dmg="Akeru-Bot-${version}-arm64.dmg"
base="https://github.com/opencoredev/akeru-bot/releases/download/${tag}"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
curl -fL -o "$tmp/$dmg" "$base/$dmg"

echo "Verifying checksum..."
line="$(grep -E "^[a-fA-F0-9]{64}[[:space:]]+\*?${dmg}\$" "$tmp/SHA256SUMS")" || exit 1
( cd "$tmp" && printf "%s\n" "$line" | shasum -a 256 -c - )

echo "Installing..."
hdiutil attach "$tmp/$dmg" -nobrowse -readonly -mountpoint "$mnt"
app="/Applications/Akeru Bot (Alpha).app"
source_app="$mnt/Akeru Bot (Alpha).app"
prepared_app="$tmp/Akeru Bot (Alpha).app"
ditto "$source_app" "$prepared_app"
identifier="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$prepared_app/Contents/Info.plist")"
[ "$identifier" = dev.leodoes.akeru ]
install_id="$(uuidgen)"
new_app="/Applications/.Akeru Bot (Alpha).app.installing.$install_id"
old_app="/Applications/.Akeru Bot (Alpha).app.backup.$install_id"
osascript - "$prepared_app" "$new_app" "$old_app" "$app" <<'APPLESCRIPT'
on run argv
  set preparedApp to quoted form of item 1 of argv
  set newApp to quoted form of item 2 of argv
  set oldApp to quoted form of item 3 of argv
  set installedApp to quoted form of item 4 of argv
  do shell script "rm -rf " & newApp & " " & oldApp & " && test ! -e " & newApp & " && test ! -e " & oldApp & " && { ditto " & preparedApp & " " & newApp & " || { rm -rf " & newApp & "; exit 1; }; } && { test ! -e " & installedApp & " || mv " & installedApp & " " & oldApp & "; } && { mv " & newApp & " " & installedApp & " || { test ! -e " & oldApp & " || mv " & oldApp & " " & installedApp & " || { rm -rf " & newApp & "; echo Previous application remains at " & oldApp & " >&2; exit 1; }; rm -rf " & newApp & "; exit 1; }; } && rm -rf " & oldApp with administrator privileges
end run
APPLESCRIPT
xattr -d com.apple.quarantine "$app" 2>/dev/null || true
open "$app"
echo "Installed Akeru Bot $tag."
