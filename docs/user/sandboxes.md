# Configure sandboxes

Open **Settings > Sandbox** to connect a remote sandbox provider. Akeru Bot supports E2B, Daytona, Vercel Sandbox, and Upstash Box. Local needs no credential and is always available.

Select **Connect** and enter the provider credentials. The server stores secret values outside `settings.json`. A client receives only a redacted marker for each saved secret.

Only connected providers appear in the default sandbox selector. Disconnecting the default provider changes the default to Local. Akeru pauses remote sandboxes when bots are idle and reconnects to the saved provider workspace when work resumes.

The default applies when a bot has no sandbox override. A bot with an explicit sandbox keeps that choice. Connect that provider before you start the bot.

Changing a provider credential replaces active sessions that use that connection. This prevents an existing session from continuing with an old account credential.
