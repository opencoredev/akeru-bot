# Run Akeru in the background

Linux and macOS can run the command-line server as a service for the current user.

## Manage the service

Install the latest release:

```bash
npx akeru-bot@latest service install
```

Check its state:

```bash
npx akeru-bot@latest service status
```

Update or repair it:

```bash
npx akeru-bot@latest service update
```

Stop it and remove it from startup:

```bash
npx akeru-bot@latest service uninstall
```

An update restarts Akeru. Let active agent work and terminal commands finish first. Wait when another
local or remote update is already running.

## Updates and rollback

The service uses a stable launcher and installs exact Akeru versions separately. Before a remote
candidate starts, the launcher snapshots the database. A failed candidate can return to the previous
server and database without rewriting the service definition.

An older launcher can require one local `service update` before remote rollback is available.

## Linux

Linux installs a systemd user unit at `~/.config/systemd/user/t3code.service`. Installation enables
lingering, so the service starts at boot and remains available after you log out.

## macOS

macOS installs a launch agent at
`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`. It starts when you log in and stops when
you log out.

For an unattended Mac, keep the Mac awake and configure an account to log in after restart. FileVault
can prevent automatic login.

An install over SSH needs a user logged in at the Mac to start the launch agent immediately. Without
that session, installation can finish but the agent starts at the next login.

If agent work cannot read Desktop, Documents, or Downloads, grant Full Disk Access to the Node.js
binary listed in the launch agent's `ProgramArguments`. Also check **System Settings > General >
Login Items** if the launch agent does not start.

Windows does not support the background service yet.
