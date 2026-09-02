# Install Akeru Bot

Akeru Bot runs on your machine. The desktop app includes the server. The command-line package runs
the same server for web and remote clients.

## Desktop app

Download the current installer from
[GitHub Releases](https://github.com/opencoredev/akeru-bot/releases).

- macOS: Apple silicon DMG
- Windows: Windows 10 or 11 x64 installer
- Linux: x86_64 AppImage

Open the app, add a project, then open **Settings > Providers** to connect an account. The desktop
app manages the local server.

## Command-line server

The command-line server requires Node.js `^22.16 || ^23.11 || >=24.10`.

Run the latest release without installing it globally:

```bash
npx akeru-bot@latest
```

The command starts the server and opens the local web app. Run this for the complete command list:

```bash
npx akeru-bot@latest --help
```

On macOS, install from Terminal. Safari and Chrome quarantine unsigned apps, so a browser
download looks damaged even when the file is fine. `curl` does not set that flag:

```bash
(
set -euo pipefail
[ "$(uname -s)" = Darwin ]
[ "$(uname -m)" = arm64 ]
tmp="$(mktemp -d)"
mnt="$tmp/mnt"
trap 'hdiutil detach "$mnt" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
mkdir -p "$mnt"
tag="$(curl -fsSL https://api.github.com/repos/opencoredev/akeru-bot/releases/latest | sed -n 's/.*"tag_name":[[:space:]]*"\(v[0-9][^"]*\)".*/\1/p' | head -1)"
[[ "$tag" =~ ^v[0-9]+[.][0-9]+[.][0-9]+$ ]]
version="${tag#v}"
dmg="Akeru-Bot-${version}-arm64.dmg"
base="https://github.com/opencoredev/akeru-bot/releases/download/${tag}"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
curl -fL -o "$tmp/$dmg" "$base/$dmg"
line="$(grep -E "^[a-fA-F0-9]{64}[[:space:]]+\*?${dmg}\$" "$tmp/SHA256SUMS")" || exit 1
( cd "$tmp" && printf "%s\n" "$line" | shasum -a 256 -c - )
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
)
```

This resolves one GitHub tag, downloads that tag's arm64 DMG and `SHA256SUMS`, verifies the
checksum, installs **Akeru Bot (Alpha).app** into `/Applications`, and opens it.

Windows and Linux installers are on the same [GitHub Releases](https://github.com/opencoredev/akeru-bot/releases)
page.

If Safari or Chrome already downloaded the DMG, discard that copy and use the Terminal command.
Do not turn off Gatekeeper or change a system-wide security setting.

Use the [background service](./background-service.md) when the server must stay available after you
close the terminal.

## Connect a subscription

Open **Settings > Providers** on any connected client. The **Subscriptions** section supports:

| Account         | Supported access                        |
| --------------- | --------------------------------------- |
| ChatGPT         | Plus, Pro, Business, Enterprise, or Edu |
| Claude          | Pro or Max                              |
| Grok            | Shared xAI login                        |
| Kimi For Coding | Kimi For Coding plan                    |
| OpenCode Go     | OpenCode Go API key                     |

Select **Connect** and finish the provider's sign-in flow. ChatGPT, Grok, and Kimi use a device code.
Claude asks you to paste the returned authorization code into Akeru. OpenCode Go asks you to paste an API key.

The environment server owns the connection, so you connect once per environment. It stores provider
credentials outside the workspace. Web, desktop, and mobile clients only receive connection
status and sign-in progress.

After sign-in, select **Check OAuth** to test an OAuth login or **Check key** to test OpenCode Go.
Use **Reconnect** after a revoked or expired login. Akeru cannot verify whether an xAI login includes
SuperGrok or X Premium+.

## What Akeru runs

Codex and Kimi use Akeru's custom Mastra-based runtime. Akeru supplies the workspace, memory,
plugins, approval rules, and subscription access for each thread.

Claude, Grok, and OpenCode use their provider adapters. OpenCode Go uses Akeru's Mastra-based runtime.
Both paths keep provider-specific session and permission behavior behind the same Akeru thread interface.

## Next steps

- [Configure bots](./bots.md)
- [Choose a permission mode](./permission-modes.md)
- [Connect another device](./remote-access.md)
- [Use Codex](./providers-codex.md)
- [Use Claude](./providers-claude.md)
