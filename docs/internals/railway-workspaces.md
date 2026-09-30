# Railway workspace adapter

`apps/server/src/provider/botWorkspace.ts` uses the official `railway` SDK. Creation and saved-ID reattachment receive explicit `RAILWAY_API_TOKEN` and `RAILWAY_ENVIRONMENT_ID` values from the environment's sandbox settings, not ambient process credentials. The token follows the existing secret-store and client-redaction path.

The shared identity file persists the Railway sandbox ID. Reattachment uses `Sandbox.connect` and verifies live status; unavailable identities fail closed without creating a replacement. `refresh` maps running, creating, and terminal states to the existing workspace state model. Only `SandboxNotFoundError` is converted to missing; authorization and network failures propagate.

Railway identity hashes exclude the credential fingerprint while pool keys retain it. Rotating credentials creates a fresh SDK client but reconnects to the same saved VM, including after a server restart. Changing environments or revoking access fails closed rather than abandoning the old identity and creating a second billable VM. Settings requires explicit acknowledgement of the Railway-dashboard retirement path before replacing or removing existing credentials; this is not automatic remote cleanup.

The workspace pool serializes Railway acquisition and release by durable identity across credential-scoped clients. A destroy request waits for the final identity lease, invalidates idle clients, and deletes the VM once. Shutdown waits for pending identity operations and deduplicates deletion. Creation after deletion starts a fresh lifecycle; stale clients cannot reattach from the idle cache.

Railway has no SDK pause/resume operation. Workspace-pool release is therefore nondestructive: sleep is a no-op, wake verifies the VM is running, and destroy deletes the VM before the shared wrapper removes its identity file. Disk checkpoints are a Railway capability, not a substitute for pause/resume: restoring one creates a different VM and cannot transparently preserve the saved identity. No checkpoint API is added to the common workspace contract.

Commands use the existing shell quoting and map cwd, environment, and millisecond timeouts to SDK options. A null exit code is treated as failure, never successful execution.

Browser endpoint resolution fails explicitly because Railway previews require CLI tunnels. Private network addresses must not be returned as client-accessible preview URLs. There is no automatic tunnel process or local/remote origin assumption in this adapter.

Browser-dependent MCP connectors are rejected before a Railway workspace lease is acquired, so unsupported browser setup cannot invoke destructive acquisition-failure cleanup on a durable VM.

Railway session-setup and workspace-wake failures never destroy the VM. Multiple credential-scoped clients may refer to one durable identity, so a failed new client must not invalidate another active session. Explicit workspace destruction remains destructive. The retirement confirmation stores only a Railway save/disconnect action and applies it to current settings, preserving unrelated changes received while the dialog is open.
