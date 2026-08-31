# Running Akeru Bot in the background

On Linux and macOS, Akeru Bot can run as a background service for your user, so it is ready without
keeping a terminal open.

## Manage the service

Install it with the latest Akeru Bot release:

```sh
npx akeru-bot@latest service install
```

Check whether it is installed:

```sh
npx akeru-bot@latest service status
```

Update or repair it:

```sh
npx akeru-bot@latest service update
```

Stop it and remove it from startup:

```sh
npx akeru-bot@latest service uninstall
```

Updating restarts Akeru Bot briefly. Let active agent work and terminal commands finish first.
If a remote update is already in progress, wait for it to finish before retrying a local update.

The service runs a small stable launcher. Exact Akeru Bot versions are installed separately, so a
failed remote candidate can return to the previous version without rewriting the service
definition. The launcher snapshots the database before a remote candidate starts, so database
updates roll back with the server version. An older launcher may require one local
`service update` before this is available.

## Platform support

**Linux** uses a systemd user unit at `~/.config/systemd/user/t3code.service`. The service starts
when the machine boots and keeps running after you log out (lingering is enabled during install).

**macOS** uses a launch agent at `~/Library/LaunchAgents/com.t3tools.t3code.service.plist`. It
starts when you log in, not when the Mac boots, and it stops when you log out; macOS has no
equivalent of Linux lingering for user agents. For a Mac that should stay reachable unattended,
turn on automatic login (System Settings → Users & Groups; unavailable while FileVault is on) and
keep the Mac from sleeping.

A few more macOS notes:

- Installing over SSH needs someone logged in at the Mac's screen to start the agent right away.
  Without that, the install command reports an error at the final start step, but the agent is
  fully installed and starts at the next login.
- macOS may show privacy prompts for protected folders such as Desktop, Documents, or Downloads,
  attributed to a bare `node` process, or deny access without a prompt. If agent work fails to
  read those folders, grant Full Disk Access to the node binary listed in the launch agent's
  `ProgramArguments`.
- The agent appears under System Settings → General → Login Items. If it was switched off there,
  or disabled with `launchctl disable`, macOS will not start it at login until you switch it back
  on.

**Windows** is not supported yet.
