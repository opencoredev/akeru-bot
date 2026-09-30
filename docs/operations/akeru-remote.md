# Akeru Remote operations

> Maintainer runbook for releases, services, and diagnostics. Using Akeru Bot? See
> [remote access](../user/remote-access.md).

Akeru Remote runs an Akeru environment on a machine you control. The supported paths are the
Linux/macOS installer, the Windows PowerShell installer, and the Docker Compose deployment.
Tailscale Serve is the default endpoint; direct loopback plus a user-managed HTTPS proxy is the
fallback. SSH forwarding can be used by the desktop client.

## Installation

The installers download a release manifest, verify its detached signature and SHA-256 checksums,
install the runtime below `~/.local/share/akeru` (or the configured install root), and register a
per-user service. Use `--no-tailscale` when Tailscale is managed separately. Akeru state lives in
`AKERU_HOME`, or `~/.akeru` when it is unset. The installers, the `akeru` launcher, and the admin
helpers derive the server's `T3CODE_HOME` from that value, so an ambient T3 Code home is never used.
Pass `--base-dir PATH` to an `akeru` server command to choose another directory explicitly.

```sh
curl -fsSL --proto '=https' https://github.com/opencoredev/akeru-bot/releases/latest/download/install-remote.sh | sh
# or, on Windows:
# irm https://github.com/opencoredev/akeru-bot/releases/latest/download/install-remote.ps1 -OutFile install-remote.ps1
# powershell -NoProfile -ExecutionPolicy Bypass -File .\install-remote.ps1
```

Release archives are published for Linux x64, macOS arm64, and Windows x64. The installers refuse
other platforms; use Docker or build from source there.

The installer records the owned Tailscale Serve mapping and refuses to remove a handler graph that
has changed. If installation or cleanup is interrupted, rerun the same command and inspect the
saved state before retrying.

## Docker

`deploy/docker/compose.yaml` runs Akeru and a Tailscale sidecar in one network namespace.
`compose.direct.yaml` binds Akeru to loopback for a reverse proxy. Mount only the workspace paths
bots need and keep the `/data` volume backed up before changing image tags.

```sh
docker compose -f deploy/docker/compose.yaml up -d
# Follow the Tailscale login URL when no TS_AUTHKEY is configured.
```

No Docker image is published. Build it from the release tag with
`AKERU_IMAGE=akeru-remote:VERSION docker compose build akeru` (see `deploy/docker/README.md`). The
image health check polls `/.well-known/t3/environment` every 30 seconds.

Account directory and relay services are intentionally outside this release. Pair clients directly
with `akeru pair --tailscale`, through a LAN or HTTPS endpoint, or through the desktop-managed SSH
tunnel.

## Administration and diagnostics

The bundled `akeru remote` helper supports `status`, `doctor`, `logs`, `update`, `rollback`,
and `uninstall`. `doctor --json` emits the typed `RemoteDoctorReport`; `--repair` only
fixes safe local permissions, log directories, and missing machine credentials. Support bundles
are redacted and written mode 0600.

`akeru remote update` works the same way on Linux, macOS, and Windows. It resolves the latest
release, checks the signed `AKERU-REMOTE-MANIFEST.txt` against the pinned release key, verifies the
platform archive's SHA-256, stages it under the install root's `versions` directory, and asks the
running service to start the transactional update. A bad signature or checksum exits non-zero
before anything is staged. On Windows, the hourly `Akeru Remote Update` scheduled task runs this
command.

The service launcher snapshots SQLite before an update, runs a trial process, and retains the prior
runtime and database for seven days. An active bot turn defers an update; the hourly timer retries.
Use `akeru remote rollback` when a committed update must be reverted.

## Reboot checks

Linux uses systemd user services and enables lingering. macOS uses per-user launch agents; Tailscale
requires the user to remain signed in. Windows uses per-user Task Scheduler tasks. From another
trusted device, check the endpoint and then run `akeru remote doctor --json` locally:

```sh
curl -fsS https://MACHINE.TAILNET.ts.net/.well-known/t3/environment
systemctl --user is-active akeru.service akeru-update.timer
```

## Publishing a release

The `remote` job in `.github/workflows/release.yml` builds one archive per supported platform on a
native runner, because the server ships native modules. `scripts/package-remote.ts archive` stages
the `pnpm deploy --prod` runtime with the runner's Node binary, the `akeru` launcher, and the admin
helpers. The publish job then copies `install-remote.sh` and `install-remote.ps1` into the release
and runs `scripts/package-remote.ts manifest`, which writes `AKERU-REMOTE-MANIFEST.txt` with SHA-256
lines for the archives, the installers, and the pinned Tailscale package, and signs it.

Signing needs the `AKERU_REMOTE_MANIFEST_SIGNING_KEY` repository secret: the PKCS#8 PEM Ed25519
private key that matches `scripts/akeru-release-manifest.pub`. The step fails when the secret is
missing or does not match the pinned public key. `scripts/verify-release-assets.ts` rejects a
release that lacks any of these assets or contains extra files.
