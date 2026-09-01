# Claude

Connect a Claude Pro or Max subscription from Akeru. Claude threads run through Akeru's Claude
adapter, which keeps Claude-specific session behavior behind the same thread controls as other
providers.

## Connect Claude

1. Open **Settings > Providers**.
2. Find **Claude** and select **Connect**.
3. Finish the Anthropic sign-in flow in the browser.
4. Copy the authorization code from Anthropic.
5. Paste the code into Akeru and select **Connect**.

The environment server completes the exchange and stores the credential. No inbound callback to the
Akeru server is required, so this flow also works from a remote browser or mobile client.

## Check the connection

The provider card reports the current state. A connected account can still show **Detected** until a
real provider request succeeds.

- Select **Check OAuth** to test the stored login.
- Select **Reconnect** after an expired or revoked login.
- Disconnect the account to remove its stored credential from this environment.

Sign-in state belongs to one environment. Connect Claude again on each separate Akeru server that
should use the account.

## Continue a Claude thread

Akeru keeps Claude's provider-specific session identity when a thread continues. Changing to an
incompatible provider starts a new provider session instead of reusing Claude's resume state.

Installed plugins and MCP servers stay attached to the Akeru thread. A provider change restarts the
provider session with the same enabled plugin set.

## Permissions

Claude maps Akeru's thread mode to its own permission behavior. Protected actions still ask even when
the thread uses **Full access**.

See [Permission modes](./permission-modes.md) for the four modes and the actions that always need
approval.
