# Configure sandboxes

Open **Settings > Sandbox** to connect E2B, Daytona, Vercel Sandbox, or Upstash Box. Local workspaces
need no credential and are always available.

Select **Connect** and enter the provider credentials. The environment stores secret values outside
`settings.json`. Clients receive only a redacted marker after a secret is saved.

## Choose the default

Only connected services appear in the default sandbox selector. Disconnecting the current default
changes the default to Local.

The default applies to a bot without its own sandbox choice. A bot-specific choice stays in place,
so connect that service before you start the bot.

## Session behavior

Akeru pauses remote sandboxes while bots are idle and reconnects to the saved provider workspace when
work resumes.

Changing a provider credential replaces active sessions that use the connection. A running session
cannot continue with the old credential.
