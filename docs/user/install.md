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

Use the [background service](./background-service.md) when the server must stay available after you
close the terminal.

## Connect a subscription

Open **Settings > Providers** on any connected client. The **Subscriptions** section supports:

| Account | Supported access |
| --- | --- |
| ChatGPT | Plus, Pro, Business, Enterprise, or Edu |
| Claude | Pro or Max |
| Grok | Shared xAI login |
| Kimi For Coding | Kimi For Coding plan |

Select **Connect** and finish the provider's sign-in flow. ChatGPT, Grok, and Kimi use a device code.
Claude asks you to paste the returned authorization code into Akeru.

The environment server owns the connection, so you sign in once per environment. It stores access
and refresh tokens outside the workspace. Web, desktop, and mobile clients only receive connection
status and sign-in progress.

After sign-in, select **Check OAuth** to test the stored login. Use **Reconnect** after a revoked or
expired login. Akeru cannot verify whether an xAI login includes SuperGrok or X Premium+.

## What Akeru runs

Codex and Kimi use Akeru's custom Mastra-based runtime. Akeru supplies the workspace, memory,
plugins, approval rules, and subscription access for each thread.

Claude, Grok, and OpenCode use their provider adapters. These adapters keep provider-specific
session and permission behavior behind the same Akeru thread interface.

## Next steps

- [Configure bots](./bots.md)
- [Choose a permission mode](./permission-modes.md)
- [Connect another device](./remote-access.md)
- [Use Codex](./providers-codex.md)
- [Use Claude](./providers-claude.md)
