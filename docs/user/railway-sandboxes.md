# Railway workspaces

Connect Railway in Settings → Sandboxes with a Railway API token and environment ID, then select Railway for your bot's workspace. The environment must have Railway Sandboxes access.

Railway workspaces are durable Linux VMs. Akeru saves the VM identity and reconnects to the same VM for later sessions. If that VM is deleted or unavailable, Akeru reports an error rather than silently replacing its files.

Railway does not offer pause/resume through its SDK. An idle bot leaves its VM running, so resource charges can continue until the workspace is destroyed. Destroying the workspace deletes the VM and clears Akeru's saved identity.

Before disconnecting Railway or changing access, stop active bot sessions and open your environment in the [Railway dashboard](https://railway.com/dashboard). Destroy any VMs you no longer need there. Disconnecting credentials in Akeru is not VM cleanup: VMs can continue accruing charges. Settings asks you to review these VMs before proceeding. When rotating a token, retain access to the same environment; Akeru reconnects to the saved VM with the new credentials. A different or inaccessible environment produces an error instead of silently creating a second VM.

Bot deletion is blocked while the bot explicitly uses Railway or inherits a Railway default. Bots inheriting Local or another provider can be deleted normally. The Railway check also applies to archived bots. Stop its sessions and retire any unneeded VM in the Railway dashboard, then switch the bot's sandbox to Local before deleting it. Akeru does not verify VM retirement: switching to Local and deleting the bot do not stop or delete a VM. Retirement remains your responsibility, including VMs from earlier sandbox selections.

## Networking and previews

Railway supports private networking, but a private VM address is not a browser preview URL. Previews require a Railway CLI tunnel. Akeru does not automatically create these tunnels and cannot route its bot browser to a Railway workspace; browser requests report this limitation instead of returning an inaccessible address. Use Railway's CLI to establish a tunnel when you need to inspect a preview manually.

Disable browser-dependent connectors before starting a Railway bot. Akeru rejects these connectors before opening the workspace, preserving the VM and its saved identity.

Railway also supports disk checkpoints through its SDK. Akeru does not currently expose Railway checkpoint creation or restoration, and does not use checkpoints to simulate sleeping a VM.

See the [official Railway SDK](https://github.com/railwayapp/railway-ts-sdk) and [sandbox capability comparison](https://sandbox-sdk.app/docs/providers).
