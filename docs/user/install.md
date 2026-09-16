# Install Akeru Bot

Akeru Bot runs on your machine. The desktop app includes the server. The command-line package runs
the same server for web and remote clients.

## Desktop app

Download the current installer from
[GitHub Releases](https://github.com/opencoredev/akeru-bot/releases).

- macOS: Apple silicon DMG, signed and notarized. Open the DMG and drag **Akeru Bot** into
  **Applications**. The app opens without a Gatekeeper warning.
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
