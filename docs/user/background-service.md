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

An update restarts Akeru. Let active bot work finish first. Wait when another
local or remote update is already running.

## Updates and rollback

The service uses a stable launcher and installs exact Akeru versions separately. Before a remote
candidate starts, the launcher snapshots the database. A failed candidate can return to the previous
server and database without rewriting the service definition.

An older launcher can require one local `service update` before remote rollback is available.

## Linux

Linux installs a systemd user unit at `~/.config/systemd/user/akeru-bot.service`. Installation enables
lingering, so the service starts at boot and remains available after you log out.

## macOS

macOS installs a launch agent at
`~/Library/LaunchAgents/dev.leodoes.akeru.service.plist`. It starts when you log in and stops when
you log out.

For an unattended Mac, keep the Mac awake and configure an account to log in after restart. FileVault
can prevent automatic login.

An install over SSH needs a user logged in at the Mac to start the launch agent immediately. Without
that session, installation can finish but the agent starts at the next login.

If bot work cannot read Desktop, Documents, or Downloads, grant Full Disk Access to the Node.js
binary listed in the launch agent's `ProgramArguments`. Also check **System Settings > General >
Login Items** if the launch agent does not start.

## Services installed by older versions

Older Akeru versions installed the service as `t3code.service` on Linux and
`com.t3tools.t3code.service` on macOS. `service status` reports such a service as needing an update.
Run `service install` or `service update` to move it to the new name. Akeru stops the old service,
starts the renamed one, and removes the old unit file. `service uninstall` removes it too.

Akeru only touches an old-named service that runs this Akeru installation's launcher. A T3 Code
service with the same name stays as it is.

Windows does not support the background service yet.
