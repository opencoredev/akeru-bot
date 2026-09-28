# Configure sandboxes

Open **Settings > Sandbox** to connect E2B, Daytona, Vercel Sandbox, Upstash Box, or Tenki. Local workspaces
need no credential and are always available.

Tenki runs coding agents in full Linux VMs and supports public previews, disk and memory snapshots,
and persistence until you clean up the sandbox. Connect it with your `TENKI_API_KEY`.
Tenki previews are public: anyone with a preview URL can access it. Pausing preserves VM memory
and disk but clears `/tmp`; keep durable files under `/home/tenki`.
The sandbox browser is not available on Tenki: Akeru does not expose browser control through a public
preview URL. This does not prevent agents from running commands in the VM.

Select **Connect** and enter the provider credentials. The environment stores secret values outside
`settings.json`. Clients receive only a redacted marker after a secret is saved.

## Choose the default

Only connected services appear in the default sandbox selector. Disconnecting the current default
changes the default to Local.

The default applies to a bot without its own sandbox choice. A bot-specific choice stays in place,
so connect that service before you start the bot.

## Session behavior

Akeru pauses remote sandboxes while bots are idle and reconnects to the saved provider workspace when
bot work resumes.

Changing a provider credential replaces active sessions that use the connection. A running session
cannot continue with the old credential.
