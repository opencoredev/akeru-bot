# Remote access

Connect a phone, tablet, browser, or desktop app directly to an Akeru server that you control.

## Pair with a running server

Run this on the server machine:

```bash
npx akeru-bot pair
```

The command finds the server and prints a one-time pairing URL and QR code. The other device must be
able to reach the address in that URL.

For Tailscale HTTPS, run:

```bash
npx akeru-bot pair --tailscale
```

Akeru configures Tailscale Serve when needed and prints a link for the machine's HTTPS MagicDNS
address.

On a terminal, the command also prints a QR code of the full pairing URL. Scan it with the other
device instead of copying the link. Pass `--no-qr` to print only the URL. The QR code is left out
when the output goes to a file or another program.

If a tunnel you manage publishes the server, pass the public origin so the link points at it
instead of the server's own address:

```bash
npx akeru-bot pair --public-url https://akeru.example.com
```

The value must be an `http` or `https` origin without a path. It cannot be combined with
`--tailscale`.

Treat a pairing link like a password. The default command creates a link that expires and works once.

### Pair the first admin device

`akeru pair` links grant standard access: the device can use chats and bots, but it cannot manage
**Settings > Connections**. The first device on a new Akeru Remote install needs admin access.

When a remote install starts with no admin device paired, it prints one admin pairing link and QR
code, and says that the link grants admin scope. For the background service, read it from the
service log:

```bash
akeru remote logs
```

You can also create an admin link on the server machine:

```bash
akeru pair --admin --tailscale
```

An admin link lets that device pair and revoke other devices and change connection settings. It
works once. `akeru pair --admin` stops working as soon as any admin device is paired. From then on,
create links from **Settings > Connections** on that device, or use `akeru pair` for standard
links.

## Create a link from the desktop app

1. Open **Settings > Connections**.
2. Under **This environment**, choose a reachable LAN, Tailscale, or custom HTTPS endpoint.
3. Set the endpoint as the default when needed.
4. Select **Create link**.
5. Open the link on the other device.

A loopback address works only on the server machine. A LAN address requires both devices to reach
the same network. A browser loaded over HTTPS can connect only to an HTTPS and WSS endpoint.

The client connects to the selected endpoint. Akeru does not proxy the session through a hosted
service.

## Run a headless server

Bind the server to the machine's Tailscale address:

```bash
npx akeru-bot serve --host "$(tailscale ip -4)"
```

Or let Akeru configure Tailscale Serve:

```bash
npx akeru-bot serve --tailscale-serve
```

Use `--tailscale-serve-port` to select another HTTPS port. Run this for all server flags:

```bash
npx akeru-bot serve --help
```

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

The desktop app can start or reuse an Akeru server on an SSH host.

1. Open **Settings > Connections**.
2. Select **Add environment**.
3. Select the SSH connection.
4. Enter a target such as `user@example.com`.
5. Confirm the launch.

The desktop app starts the remote server and opens a local port forward. The remote machine owns its
projects, chats, files, terminals, Git state, subscriptions, and provider sessions.

The remote host needs Node.js `^22.16 || ^23.11 || >=24.10`. Check the non-interactive shell when
startup fails:

```bash
ssh user@example.com 'sh -lc "command -v node && node --version"'
```

Configure the remote version manager until that command prints a supported Node.js version.

## Manage saved access

After pairing, the client stores a bearer credential for the environment. It reconnects without the
original pairing link.

Inspect sessions, create links, and revoke access from the command line:

```bash
npx akeru-bot auth --help
```

Web and desktop show saved connections under **Connections**. Mobile shows them under
**Environments**. Removing a saved connection deletes it from that client. Revoke the server session
when the device must lose access.

Prefer a private network such as Tailscale. Do not expose an HTTP server directly to the public
internet. Use HTTPS and WSS across untrusted networks.

See [Running Akeru Bot in the background](./background-service.md) for an unattended server.
