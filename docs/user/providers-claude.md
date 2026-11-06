# Claude

Connect Claude to Akeru with an Anthropic API key. Claude chats run through Akeru's built-in runtime,
with the same chat controls as other providers. The Claude CLI is not required.

Akeru does not offer Claude Pro or Max sign-in. Anthropic does not allow third-party apps to offer
claude.ai login or use subscription rate limits, so Claude requests from Akeru are billed to your
Anthropic API account in the [Claude Console](https://console.anthropic.com/settings/keys).

## Connect Claude

1. Create an API key in the Claude Console.
2. Open **Settings > Providers**.
3. Find **Claude** and select **Connect**.
4. Paste the key. To use an Anthropic-compatible gateway, enter its base URL too.
5. Select **Save**.

The environment server stores the key. Clients never receive it, so this also works from a remote
browser or mobile client.

## If you used Claude Pro or Max sign-in before

Earlier Akeru versions let you sign in with a Claude Pro or Max account. Those logins no longer work.
When the environment starts, Akeru deletes them, including logins saved for backup accounts, so no
Claude subscription token stays on the server. The Claude row shows **Not connected** with a note
that subscription sign-in is no longer supported, and a bot that uses Claude says to add an
Anthropic API key when you message it. Add a key as described above. Your bots, chats, and settings
stay as they are.

If you go back to an older Akeru version afterward, sign in to Claude Pro or Max again there. The
deleted login is not restored.

## Check the connection

The provider card reports the current state. A saved key can still show **Not verified yet** until a
real provider request succeeds.

- Select **Check key** to test the stored key.
- Select **Replace key** after you rotate or revoke a key.
- Disconnect to remove the key from this environment.

A rejected key means the key was revoked or its Anthropic account has no billing. A rate-limit
failure means you should send the message again later. Anthropic sets API rate limits by usage tier.

Keys belong to one environment. Add the key again on each separate Akeru server that should use it.

Chat titles and worktree branch names use the same key as Claude chats. On a remote connection, the
key stays on the connected environment server.

## Continue a Claude chat

Akeru keeps Claude's provider-specific session identity when a chat continues. Changing to an
incompatible provider starts a new provider session instead of reusing Claude's resume state.

Installed plugins and MCP servers stay attached to the Akeru chat. A provider change restarts the
provider session with the same enabled plugin set.

## Permissions

Claude maps Akeru's chat mode to its own permission behavior. Protected actions still ask even when
the chat uses **Full access**.

See [Permission modes](./permission-modes.md) for the four modes and the actions that always need
approval.
