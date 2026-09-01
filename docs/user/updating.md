# Keep the app and server in sync

Akeru works best when a client and its connected environment server use the same version. A version
mismatch appears above the composer and under **Settings > Connections**.

Dismissing the composer notice hides that reminder for the two current versions. It does not update
the server. Connections still shows the mismatch.

## Before an update

Let active agent work and terminal commands finish. A server update interrupts the connection and
can stop work that is still running. It does not remove threads, settings, or project files.

## Update the environment

The available action depends on how the environment started.

- A supported background service can offer an update action in Akeru. Keep the client open while it
  downloads, verifies, restarts, and reconnects.
- A desktop-managed environment tells you to update the desktop app on the machine that owns the
  server.
- A command-line environment offers **Copy update command**. Run the copied command on the server
  machine with its normal startup flags.

The manual command pins the server to the client version:

```bash
npx akeru-bot@<client-version>
```

For the background service, pin the same version like this:

```bash
npx akeru-bot@<client-version> service update
```

`service update` installs the version of the package that invoked it. `@latest` only resolves a
mismatch when the client already uses the latest release.

An older launcher can ask for one exact local service update before Akeru can perform future remote
updates safely.

## Follow progress

The notice shows **Downloading…** while Akeru fetches and verifies the candidate. It shows
**Restarting…** while the replacement server starts. The same state appears in the composer and
Connections.

A failed update stays visible with its error and retry action. A rollback appears as soon as the
launcher returns to the previous version.

If an update fails:

1. Retry the offered action once.
2. Confirm that you updated the machine named in the notice.
3. Relaunch a command-line server with `npx akeru-bot@<client-version>`.

See [Run Akeru in the background](./background-service.md) for service commands.

## Mobile updates

The mobile app downloads its own update in the background and installs it after you leave the app.
It saves unsent drafts and queued messages before restart.

If the app stays open for too long to install the update, it asks whether to install now. **Later**
keeps the pending automatic install.

See [Remote access](./remote-access.md) for connection setup.
