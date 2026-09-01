# Remote access

Use remote access to connect a phone, tablet, browser, or desktop app to an Akeru Bot server that you
control.

## Pair with a running server

Run this on the server machine:

```bash
npx akeru-bot pair
```

The command finds the running server, creates a one-time pairing credential, and prints a URL and QR
code. The other device must be able to reach the address in that URL.

For Tailscale HTTPS, run:

```bash
npx akeru-bot pair --tailscale
```

This configures Tailscale Serve when needed and prints a pairing URL for the machine's HTTPS
MagicDNS address.

Treat a pairing URL like a password. The credential expires and ordinary pairing links work once.

## Desktop network access

1. Open **Settings** and select **Connections**.
2. Enable **Network access** under **This environment**.
3. Select a reachable LAN, Tailscale, or custom HTTPS endpoint.
4. Select **Create Link**.
5. Open the link on the other device.

A loopback address works only on the same machine. A LAN address requires both devices to reach the
same network. A browser loaded over HTTPS can connect only to an HTTPS and WSS server.

The client connects directly to the address in the link. Akeru Bot does not proxy the connection
through a hosted service.

## Headless server

Run a server without the desktop app:

```bash
npx akeru-bot serve --host "$(tailscale ip -4)"
```

The command prints the server address, pairing credential, URL, and QR code.

To let Akeru Bot configure Tailscale Serve, run:

```bash
npx akeru-bot serve --tailscale-serve
```

Use `--tailscale-serve-port` to choose another HTTPS port. Use `akeru serve --help` for the full
flag list.

## Desktop-managed SSH

The desktop app can start or reuse a server on an SSH host.

1. Open **Settings** and select **Connections**.
2. Select **Add environment**.
3. Select the SSH flow.
4. Enter a target such as `user@example.com`.
5. Confirm the launch.

The desktop app starts the remote server and opens a local port forward. The remote machine owns its
projects, threads, files, terminals, git state, and provider sessions.

The SSH launcher requires a compatible Node.js version on the remote host:

```text
^22.16 || ^23.11 || >=24.10
```

Check the non-interactive shell if launch fails:

```bash
ssh user@example.com 'sh -lc "command -v node && node --version"'
```

Configure the remote version manager so that command prints a compatible Node.js version.

## Saved environments

After pairing, the client stores a bearer credential for that environment. It reconnects without
reusing the original pairing URL.

Use `akeru auth` to inspect sessions, create another pairing link, or revoke access:

```bash
npx akeru-bot auth --help
```

Remove a saved environment from **Connections** on web or desktop, or **Environments** on mobile.
This removes the local saved connection. Revoke the server session when the device should no longer
have access.

## Security notes

- Prefer a private network such as Tailscale.
- Do not expose an HTTP server directly to the public internet.
- Use HTTPS and WSS across untrusted networks.
- Revoke links or sessions that you no longer trust.
- Finish active work before updating a remote server because the server restarts.

See [background service](./background-service.md) for a Linux server that must remain available
after logout.
