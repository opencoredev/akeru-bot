# Configure sandboxes

Open **Settings > Sandbox** to connect E2B, Daytona, Vercel Sandbox, Upstash Box, Tenki, Railway,
Boat, or Ascii Box. Local workspaces and Local Docker need no credential and are always available.

Select **Connect** and enter the provider credentials. The environment stores secret values outside
`settings.json`. Clients receive only a redacted marker after a secret is saved.

| Sandbox        | Credentials                                           | Pauses when idle | Sandbox browser             |
| -------------- | ----------------------------------------------------- | ---------------- | --------------------------- |
| Local          | None                                                  | No               | Yes                         |
| Local Docker   | None. Docker must run on the environment computer.    | Yes              | Yes                         |
| E2B            | `E2B_API_KEY`                                         | Yes              | Yes, with an access token   |
| Daytona        | `DAYTONA_API_KEY`                                     | Daytona stops it | Yes, with a preview token   |
| Vercel Sandbox | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | Yes              | Yes, through a public route |
| Upstash Box    | `UPSTASH_BOX_API_KEY`                                 | Yes              | Yes, with a bearer token    |
| Tenki          | `TENKI_API_KEY`                                       | Yes              | No                          |
| Railway        | `RAILWAY_API_TOKEN`, `RAILWAY_ENVIRONMENT_ID`         | No               | No                          |
| Boat           | `BOAT_API_KEY`                                        | Boat pauses it   | Yes, with a preview cookie  |
| Ascii Box      | Box API key (`BOX_API_KEY`)                           | Yes              | Yes, with a protected URL   |

Commands and relative file paths start in `/workspace` on new remote sandboxes. A sandbox created by
an earlier Akeru version keeps the directory it used before, so a bot still finds its files there.

## Choose the default

Only connected services appear in the default sandbox selector. Local and Local Docker are always
listed. Disconnecting the current default changes the default to Local.

The default applies to a bot without its own sandbox choice. A bot-specific choice stays in place,
so connect that service before you start the bot.

## Session behavior

Akeru saves the ID of each remote sandbox as soon as the provider creates it, and reconnects to that
sandbox when bot work resumes. If setup fails after the sandbox exists, the saved ID stays so the
next session reuses it. If deleting a sandbox fails, Akeru keeps the ID and tries again on the next
cleanup. If a saved sandbox is missing or unreachable, Akeru reports an error instead of creating a
replacement.

Akeru pauses idle sandboxes on providers that support pausing: Local Docker, E2B, Vercel Sandbox,
Upstash Box, Tenki, and Ascii Box. If a pause fails, Akeru keeps the sandbox and retries the pause
while it stays idle. Daytona and Boat have no pause operation, so Akeru leaves those sandboxes to
the provider: Daytona stops idle sandboxes on its own schedule and Akeru starts them again on the
next use, and Boat pauses idle VMs and wakes them on the next request.

Railway VMs remain running while idle and can continue accruing charges. Previews require a Railway
CLI tunnel, so Akeru cannot attach its sandbox browser. See [Railway workspaces](railway-sandboxes.md)
for credential rotation and VM cleanup.

Changing a provider credential replaces active sessions that use the connection. A running session
cannot continue with the old credential.

## Provider notes

**Local Docker** runs each bot in a container on the environment computer, using the `node:22-bookworm`
image. The sandbox browser reaches the container through a port bound to the environment's loopback
address. Hosted connectors such as Tinyfish can't reach that address, so they start without a sandbox
browser connection. Connectors that run on the environment computer still receive it.

**Tenki** runs full Linux VMs with disk and memory snapshots. Pausing preserves VM memory and disk
but clears `/tmp`. Tenki previews are public: anyone with a preview URL can access it. Akeru does not
expose browser control through a public preview URL, so the sandbox browser is not available on
Tenki. Agents can still run commands in the VM. Tinyfish connectors can still start,
but receive no sandbox browser connection.

**Vercel Sandbox** serves the sandbox browser on a port that Vercel routes publicly. On a sandbox
created by an earlier Akeru version, Akeru adds that route the first time the browser starts and
keeps the sandbox's other routes.

**Ascii Box** runs persistent Linux VMs. Pausing saves a native lifecycle snapshot, and resuming
restores that workspace; archival can take up to five minutes. Ascii Box supports public previews
by default, so do not expose sensitive services. Akeru requests protected, token-authenticated
access for its browser-control endpoint. New VMs do not inherit credentials from your Ascii account
environment. Commands support timeouts of up to ten minutes; longer timeouts are rejected before
the command starts rather than silently shortened.

Ascii Box is now Boat. The Ascii Box integration uses the legacy Box API, which the provider supports
until its announced sunset. See the [migration notice](https://docs.boat.dev/migrating-from-box).
Connect Boat with a Boat API key for new bots.
