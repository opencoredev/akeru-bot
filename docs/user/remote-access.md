# Remote access

Reach an Akeru Bot environment from another device: a phone, a tablet, a browser, or a second
computer. The environment server keeps owning projects, chats, files, terminals, Git state, and
provider sessions. Remote access only changes how a client reaches that server. Nothing proxies
through a hosted Akeru service.

## Choose a route

Pick the route that matches how the second device can reach the server machine.

| Route               | Best for                                                        | Encrypted endpoint                         |
| ------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| Tailscale           | Any two devices, anywhere                                       | Yes, HTTPS through Tailscale Serve         |
| SSH forwarding      | The desktop app on a machine with SSH access to the server host | Yes, inside the SSH tunnel                 |
| User-managed tunnel | You already run a reverse proxy or tunnel with HTTPS            | Yes, if your proxy terminates TLS          |
| LAN                 | Both devices on the same trusted network                        | No                                         |
| Docker              | A server host where you prefer containers                       | Yes, through the bundled Tailscale sidecar |

Akeru does not include a hosted account, relay, or device list. Pair clients directly to the
server.

## Run the server

### Install with the one-line installer (Linux, macOS, Windows)

The installer downloads the latest release, verifies its signed manifest and SHA-256 checksums,
installs under a per-user directory, and registers a background service. On Linux and macOS:

```sh
curl -fsSL --proto '=https' https://github.com/opencoredev/akeru-bot/releases/latest/download/install-remote.sh | sh
```

On Windows, download the installer to a file and run it from PowerShell. The saved file is what
lets the installer request administrator access for the background service:

```powershell
Invoke-WebRequest -UseBasicParsing -OutFile "$env:TEMP\install-remote.ps1" `
  https://github.com/opencoredev/akeru-bot/releases/latest/download/install-remote.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install-remote.ps1"
```

Release archives exist for Linux x64, macOS arm64, and Windows x64. On other platforms the
installer refuses and you should use Docker or the command-line package instead.

By default the installer sets up Tailscale and publishes the server through Tailscale Serve.
Pass `--no-tailscale` (or `-NoTailscale` on Windows) to install without it, for example when
Tailscale is managed separately or you plan to use your own tunnel. Pass `--no-auto-update`
(`-NoAutoUpdate`) to skip the hourly update task. Server state lives in `~/.akeru` unless
`AKERU_HOME` points elsewhere.

When installation finishes, pair a client with `akeru pair --tailscale`.

### Run with Docker

The Docker deployment runs Akeru and a Tailscale sidecar in one network namespace, so Tailscale
terminates tailnet HTTPS and forwards to Akeru. Releases do not publish a ready-made Docker
image, so this deployment runs from a source checkout. See the Docker setup and maintenance runbook in
[Akeru Remote operations](../operations/akeru-remote.md#docker) for the compose files, image
build, and the loopback-only variant for a reverse proxy.

Once the stack is up and Tailscale is signed in, pair a client with:

```sh
docker compose exec akeru akeru pair --tailscale
```

Data is durable in the `akeru-data` volume; keep it backed up before changing versions. Inside
the container, `akeru remote doctor`, `status`, and `logs` work. Updates, rollback, and removal
stay Compose operations.

### Run a one-off headless server

Without the installer, start the command-line server directly:

```sh
npx akeru-bot@latest serve
```

It prints a pairing URL and QR code. Useful flags:

- `--host` to bind a specific interface, such as a LAN address or `tailscale ip -4`.
- `--port` to choose the port.
- `--tailscale-serve` to publish the server over Tailscale Serve HTTPS, with
  `--tailscale-serve-port` for a port other than 443.

Run `npx akeru-bot@latest serve --help` for the full flag list.

## Pair a client

Every pairing flow ends in a pairing URL. The URL carries a one-time credential that the client
exchanges for a saved bearer session. After that first exchange, the client reconnects without
the link.

Treat a pairing URL like a password. It grants real access until it expires or is used.

### Pair from the command line

Run this on the server machine:

```sh
akeru pair
# or, on an npx-installed server:
npx akeru-bot@latest pair
```

The command finds the running server, mints a token, and prints the pairing URL and a QR code.
The default token is single-use and expires after 5 minutes; pass `--ttl` (for example `--ttl 1h`)
to extend it and `--label` to name it in the connections list.

On a terminal, the command also prints a QR code of the full pairing URL. Scan it with the other
device instead of copying the link. Pass `--no-qr` to print only the URL. The QR code is left out
when the output goes to a file or another program.

For Tailscale HTTPS:

```sh
akeru pair --tailscale
```

This configures Tailscale Serve when needed and prints a link for the machine's HTTPS MagicDNS
address. The mapping persists across restarts; remove it with `tailscale serve --https=443 off`
(substitute the port you used).

If a tunnel you manage publishes the server, pass the public origin so the link points at it
instead of the server's own address:

```sh
akeru pair --public-url https://akeru.example.com
```

The value must be an `http` or `https` origin without a path, and it cannot be combined with
`--tailscale`.

### Pair the first admin device

`akeru pair` links grant standard access: the device can use chats and bots, but it cannot manage
**Settings > Connections**. The first device on a new Akeru Remote install needs admin access.

When a remote install starts with no admin device paired, it prints one admin pairing link and
QR code at startup, and the link grants admin scope. For the background service, read it from the
service log:

```sh
akeru remote logs
```

You can also mint an admin link on the server machine while no admin client is paired:

```sh
akeru pair --admin --tailscale
```

An admin link lets that device pair and revoke other devices and change connection settings. It
works once. `akeru pair --admin` stops working as soon as any admin device is paired. From then
on, create links from **Settings > Connections** on that device, or use `akeru pair` for standard
links.

### Pair from the desktop app

1. Open **Settings > Connections**.
2. Under **This environment**, choose a reachable LAN, Tailscale, or custom HTTPS endpoint.
3. Set the endpoint as the default when needed.
4. Select **Create link**.
5. Open the link on the other device, or scan the QR code.

A loopback address works only on the server machine itself. A LAN address requires both devices
on the same network. A browser loaded over HTTPS can only connect to HTTPS and WSS endpoints, so
a Tailscale or custom HTTPS endpoint is the compatible choice for remote browsers.

### Standard versus admin scope

`akeru pair` and **Create link** in the app mint standard credentials. They grant a client
everything it needs to chat, operate terminals, and submit reviews, but they cannot list or
revoke other pairing links and sessions, which is what **Settings > Connections** uses to manage
access.

A fresh install also mints one admin-scoped pairing link at startup; see
[Pair the first admin device](#pair-the-first-admin-device). Pair that link on the client you
manage this machine from, so it can manage connections afterward. Later devices pair fine with
standard links.

If a client lacks the access scope, Connections still works but its management actions are
unavailable.

## Check remote health

On an Akeru Remote install, admin clients on web and desktop see **Remote health** under
**Settings > Connections**. It runs the same checks as `akeru remote doctor`: the background
service, storage, database, updates, Tailscale, logs, and providers. Each check shows OK, Warning,
or Failing with a short message.

Select **Re-run** to check again. Some problems show a **Repair** button. Akeru changes nothing
until you select it, and it repairs only that check.

A new install reports storage and update state as not created yet until the server has written
them. That warning clears on its own.

The section does not appear on environments that are not Akeru Remote installs, or for devices
paired with standard access. The mobile app does not show remote health yet. Run
`akeru remote doctor` on the server machine instead.

## Connect through SSH

The desktop app can start or reuse an Akeru server on an SSH host and forward a local port to
it, so no extra server-side setup is needed beyond SSH access.

1. Open **Settings > Connections**.
2. Select **Add environment**.
3. Select the SSH connection.
4. Enter a target such as `user@example.com`.
5. Confirm the launch.

The desktop starts the remote server and opens the tunnel. The remote machine owns its own
projects, chats, files, terminals, Git state, subscriptions, and provider sessions.

The remote host needs Node.js `^22.16 || ^23.11 || >=24.10`. If startup fails, check the
non-interactive shell:

```sh
ssh user@example.com 'sh -lc "command -v node && node --version"'
```

Configure the remote version manager until that command prints a supported version.

SSH access is a desktop capability. Web and mobile clients connect to a directly reachable
server through normal pairing.

## Connect through a user-managed tunnel

If you already run a reverse proxy or tunnel that terminates HTTPS (for example on a VPS or a
Cloudflare tunnel), point it at the server and pair through that address.

1. Start the server bound to loopback or the interface your proxy reaches:

   ```sh
   npx akeru-bot@latest serve --host 127.0.0.1
   ```

2. Configure your proxy to forward HTTPS and WebSocket traffic to the server's host and port.
   Both `https://` and `wss://` must reach it.
3. Mint a link that points at the tunnel's public origin and open it on the remote device:

   ```sh
   akeru pair --public-url https://tunnel.example.com
   ```

   The value must be an `http` or `https` origin without a path. In the desktop app you can also
   add the tunnel address as a custom endpoint under **Settings > Connections** and create the
   link there.

Akeru does not manage certificates on this route; your proxy owns TLS.

## Connect over a LAN

Both devices on the same trusted network can pair directly over HTTP.

1. Start the server bound to the LAN interface:

   ```sh
   npx akeru-bot@latest serve --host 0.0.0.0
   ```

   Or let the desktop app advertise a LAN endpoint under **Settings > Connections**.

2. Create a pairing link for that endpoint, or run `akeru pair` on the server machine and open
   the printed LAN URL on the other device.

LAN pairing is unencrypted HTTP. Keep it to networks you trust; prefer Tailscale or an
HTTPS tunnel anywhere else.

## Check health and diagnose

The installed remote includes a diagnostics command:

```sh
akeru remote doctor
```

It checks the background service, the Serve mapping, state directories, and stored credentials,
and reports each check as pass, warn, or fail. `akeru remote doctor --json` prints the typed
report for scripts. `akeru remote doctor --repair` fixes safe local problems such as file
permissions, missing log directories, and a missing machine credential.

Related commands:

- `akeru remote status`: doctor output plus service status.
- `akeru remote logs`: recent service log lines (journald where available).

You can also probe the endpoint directly from another device on the tailnet:

```sh
curl -fsS https://MACHINE.TAILNET.ts.net/.well-known/t3/environment
```

## Update and roll back

How updates work depends on how the server runs.

- **Installed service.** `akeru remote update` resolves the latest release, verifies the signed
  manifest and the archive checksum, stages the new version, and asks the running service to
  start a transactional update. The installer also registers an hourly task
  (`akeru-update.timer` on Linux, a launch agent on macOS, the **Akeru Remote Update** scheduled
  task on Windows) that runs the same command. An active bot turn defers an update; the hourly
  task retries. The launcher snapshots the database and keeps the previous version, so
  `akeru remote rollback` restores it.
- **Docker.** Update by rebuilding or pulling a new image tag after snapshotting the
  `akeru-data` volume. Roll back by starting the previous image; restore the volume snapshot if
  the failed image already migrated the database. `akeru remote update` exits with instructions
  inside the container.
- **`npx akeru-bot`.** Restart with the newer version, for example `npx akeru-bot@latest serve`.

## Stop or uninstall

- **Installed service.** `akeru remote uninstall` removes the background service, the hourly
  update task, the owned Tailscale Serve mapping, the `akeru` launcher, and the install
  directory. Akeru data in `~/.akeru` is kept unless you pass `--purge-data`. The command
  refuses to remove a Tailscale mapping whose handler graph has changed since Akeru recorded
  it. Inside Docker it exits with instructions; remove the stack with Compose instead.
- **Docker.** `docker compose down`. Add `-v` to also delete the data volume.
- **A running `serve` process.** Stop it in its terminal. A Tailscale Serve mapping created by
  `akeru pair --tailscale` or `--tailscale-serve` persists; remove it with
  `tailscale serve --https=443 off`.

## Manage saved access

After pairing, the client stores a bearer credential and reconnects without the original link.
Removing a saved connection deletes it from that client only. Revoke the server-side session
when a device must lose access: **Settings > Connections** lists sessions and pairing links for
admin-scoped clients, and `akeru auth --help` covers the same operations from the command line.

## Security notes

- Prefer a private network such as Tailscale. Do not expose a plain HTTP server to the public
  internet; use HTTPS and WSS across untrusted networks.
- A pairing URL is a credential. Send it through a channel you trust and let it expire rather
  than posting it somewhere persistent.
- The client connects directly to the server. No Akeru service relays the session.

See [Run Akeru Bot in the background](./background-service.md) for an unattended server and
[Keep the app and server in sync](./updating.md) for client-side update notices.
