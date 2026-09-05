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

On macOS (Apple silicon), install from Terminal. Safari and Chrome quarantine unsigned apps, so a browser
download looks damaged even when the file is fine. `curl` does not set that flag:

```bash
t=$(curl -fsSL https://api.github.com/repos/opencoredev/akeru-bot/releases/latest | sed -n 's/.*"tag_name":[[:space:]]*"\(v[0-9][^"]*\)".*/\1/p' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Akeru Bot release." >&2; (exit 1); else f=$(mktemp /tmp/akeru-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/opencoredev/akeru-bot/$t/scripts/install-macos.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/akeru-install-none}"; (exit $rc); fi
```

The command resolves the latest stable release tag, downloads that tag's installer script,
then runs it against the same tag, so script and DMG always match. The script is auditable at
[`scripts/install-macos.sh`](https://github.com/opencoredev/akeru-bot/blob/main/scripts/install-macos.sh).
It:

- Requires macOS on Apple silicon and exits otherwise.
- Resolves the latest stable `vX.Y.Z` tag via the releases API, then downloads that tag's arm64 DMG and `SHA256SUMS`.
- Verifies the DMG with `shasum -a 256 -c` against the exact checksum line before mounting.
- Checks the app bundle id is `dev.leodoes.akeru`.
- Installs **Akeru Bot (Alpha).app** into `/Applications` with an admin prompt, keeping a backup until the new copy is in place, then opens it.
- Clears the quarantine flag on the installed app only. It never disables Gatekeeper.

Windows and Linux installers are on the same [GitHub Releases](https://github.com/opencoredev/akeru-bot/releases)
page.

On Windows 10 or 11 (x64), install from PowerShell:

```powershell
$t = (Invoke-RestMethod https://api.github.com/repos/opencoredev/akeru-bot/releases/latest -ErrorAction Stop).tag_name; if ($t -match '^v\d+\.\d+\.\d+$') { $f = Join-Path $env:TEMP $("akeru-install-$([Guid]::NewGuid()).ps1"); Invoke-WebRequest "https://raw.githubusercontent.com/opencoredev/akeru-bot/$t/scripts/install-windows.ps1" -OutFile $f -ErrorAction Stop; try { & $f -Tag $t } finally { Remove-Item $f } } else { throw "Could not resolve the latest Akeru Bot release." }
```

The command resolves the latest stable release tag, downloads that tag's installer script,
then runs it against the same tag, so script and exe always match. The script is auditable at
[`scripts/install-windows.ps1`](https://github.com/opencoredev/akeru-bot/blob/main/scripts/install-windows.ps1).
It:

- Requires Windows on AMD64 and exits otherwise. ARM64 and x86 are not supported.
- Resolves the latest stable `vX.Y.Z` tag via the releases API, then downloads that tag's x64 exe and `SHA256SUMS`.
- Verifies the exe by requiring `SHA256SUMS` to contain exactly that asset's entry and matching the file's SHA-256 hash before running it.
- Unblocks the downloaded file, then runs the installer and reports `Installed Akeru Bot <tag>.`

On Linux (x86_64), install from Terminal:

```bash
t=$(curl -fsSL https://api.github.com/repos/opencoredev/akeru-bot/releases/latest | sed -n 's/.*"tag_name":[[:space:]]*"\(v[0-9][^"]*\)".*/\1/p' | head -1); if [ -z "$t" ]; then echo "Could not resolve the latest Akeru Bot release." >&2; (exit 1); else f=$(mktemp /tmp/akeru-install.XXXXXX) && curl -fsSL -o "$f" "https://raw.githubusercontent.com/opencoredev/akeru-bot/$t/scripts/install-linux.sh" && bash "$f" --tag "$t"; rc=$?; rm -f "${f:-/tmp/akeru-install-none}"; (exit $rc); fi
```

The command resolves the latest stable release tag, downloads that tag's installer script,
then runs it against the same tag, so script and AppImage always match. The script is auditable at
[`scripts/install-linux.sh`](https://github.com/opencoredev/akeru-bot/blob/main/scripts/install-linux.sh).
It:

- Requires Linux on x86_64 or amd64 and exits otherwise.
- Resolves the latest stable `vX.Y.Z` tag via the releases API, then downloads that tag's x64 AppImage and `SHA256SUMS`.
- Verifies the AppImage by requiring `SHA256SUMS` to contain that asset's entry and matching the file's SHA-256 hash before installing.
- Installs the verified AppImage to `~/.local/bin/akeru-bot`, keeping the previous copy at `~/.local/bin/akeru-bot.backup` until the new copy is in place, then reports `Installed Akeru Bot <tag>.`

If Safari or Chrome already downloaded the DMG, discard that copy and use the Terminal command above.
Do not turn off Gatekeeper or change a system-wide security setting.

Use the [background service](./background-service.md) when the server must stay available after you
close the terminal.

## Connect a subscription

Open **Settings > Providers**. Mobile lists these options under **Provider connections**:

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

After sign-in, select **Check OAuth** to test an OAuth login or **Check key** to test an API key.
Use **Reconnect** after a revoked or expired login. Akeru cannot verify whether an xAI login includes
SuperGrok or X Premium+.

### Connect an API key

Web and desktop use **Settings > Providers**. Mobile uses **Settings > Providers > Provider connections**.
Select an environment first if you have more than one environment.

ChatGPT, Claude, Grok, Kimi For Coding, and OpenCode Go accept API keys. Select **API key** beside a
provider. For OpenCode Go, select **Connect**.

Enter the key in the password field. Optionally enter a **Base URL** for a compatible endpoint.
Grok uses its default endpoint and does not show a Base URL field.
Leave the URL empty to use the provider default. The URL must use HTTP or HTTPS and must not contain
credentials, a query, or a fragment. The environment sends the key to this endpoint, so use an endpoint
you trust. API billing can be separate from your subscription.

Select **Save** to store the key on the environment. **Cancel** discards the form. A saved key has not
necessarily passed a provider request; select **Check key** to check access.

Use **Reconnect key** to replace the key or change the endpoint. OpenCode Go uses **Reconnect**.
The form shows the saved endpoint but never shows the saved key. Enter the key again when you change
the endpoint. Use **Use OAuth** to return to subscription login where supported. **Disconnect** removes
the saved connection from the environment.

## What Akeru runs

Codex and Kimi use Akeru's custom Mastra-based runtime. Akeru supplies the workspace, memory,
plugins, approval rules, and subscription access for each chat.

Claude, Grok, and OpenCode use their provider adapters. OpenCode Go uses Akeru's Mastra-based runtime.
Both paths keep provider-specific session and permission behavior behind the same Akeru chat interface.

## Next steps

- [Configure bots](./bots.md)
- [Choose a permission mode](./permission-modes.md)
- [Connect another device](./remote-access.md)
- [Use Codex](./providers-codex.md)
- [Use Claude](./providers-claude.md)
