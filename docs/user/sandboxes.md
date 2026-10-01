# Configure sandboxes

Open **Settings > Sandbox** to connect E2B, Daytona, Vercel Sandbox, Upstash Box, Tenki, Railway, or Ascii Box. Local workspaces
need no credential and are always available.

Tenki runs coding agents in full Linux VMs and supports public previews, disk and memory snapshots,
and persistence until you clean up the sandbox. Connect it with your `TENKI_API_KEY`.
Tenki previews are public: anyone with a preview URL can access it. Pausing preserves VM memory
and disk but clears `/tmp`; keep durable files under `/home/tenki`.
The sandbox browser is not available on Tenki: Akeru does not expose browser control through a public
preview URL. This does not prevent agents from running commands in the VM.
Executor and Tinyfish connectors can still start, but receive no sandbox browser connection.

Select **Connect** and enter the provider credentials. The environment stores secret values outside
`settings.json`. Clients receive only a redacted marker after a secret is saved.

## Choose the default

Only connected services appear in the default sandbox selector. Disconnecting the current default
changes the default to Local.

The default applies to a bot without its own sandbox choice. A bot-specific choice stays in place,
so connect that service before you start the bot.

## Session behavior

Akeru pauses remote sandboxes other than Railway while bots are idle and reconnects to the saved provider workspace when
bot work resumes.
If a remote pause fails, Akeru keeps the workspace and retries the pause while it remains idle,
except on Ascii Box, where it reconnects to the saved VM on the next use.

Railway VMs remain running while idle and can continue accruing charges. Connect with a
`RAILWAY_API_TOKEN` and `RAILWAY_ENVIRONMENT_ID`. Previews require a Railway CLI tunnel;
Akeru cannot attach its sandbox browser. See [Railway workspaces](railway-sandboxes.md)
for credential rotation and VM cleanup.

Ascii Box runs persistent Linux VMs. Stopping a VM saves a native lifecycle snapshot; resuming it
restores that workspace. Ascii Box supports public previews by default, so do not expose sensitive
services. Akeru requests protected, token-authenticated access for its browser-control endpoint.
If session setup fails, Akeru preserves the VM and waits for snapshot cleanup before reporting the
error. Snapshot archival can take up to five minutes; retries wait for that cleanup to finish.
New VMs do not inherit credentials from your Ascii account environment.
Ascii Box commands support timeouts of up to ten minutes. Requests for longer timeouts are rejected
before the command starts rather than silently shortened.
If Ascii confirms that a saved VM no longer exists, Akeru creates a replacement on the next use.
Connection failures and permission errors retain the saved VM identity rather than replacing it.
Connect it with a Box API key. Ascii Box is now Boat; this integration uses the legacy Box API, which
the provider supports until its announced sunset. See the [migration notice](https://docs.boat.dev/migrating-from-box).

Changing a provider credential replaces active sessions that use the connection. A running session
cannot continue with the old credential.
