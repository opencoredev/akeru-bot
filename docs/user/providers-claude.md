# Claude

Connect Claude to Akeru in one of two ways:

- **An Anthropic API key.** Claude chats run through Akeru's built-in runtime, with the same chat
  controls as other providers. The Claude CLI is not required. Requests are billed to your Anthropic
  API account in the [Claude Console](https://console.anthropic.com/settings/keys).
- **Your Claude Code login.** Akeru runs the Claude Code you installed on the environment's machine,
  and Claude Code uses the login you made there. See
  [Use your Claude Code login](#use-your-claude-code-login).

Akeru does not offer a Claude Pro or Max sign-in of its own. Anthropic does not allow third-party
apps to offer claude.ai login.

## Connect Claude

1. Create an API key in the Claude Console.
2. Open **Settings > Providers**.
3. Find **Claude** and select **Connect**.
4. Paste the key. To use an Anthropic-compatible gateway, enter its base URL too.
5. Select **Save**.

The environment server stores the key. Clients never receive it, so this also works from a remote
browser or mobile client.

## Use your Claude Code login

Claude Code must run on the same machine as the Akeru environment, the one that runs your bots.

1. Open **Settings > Providers > Claude** and select **Use your Claude Code login**.
2. If Claude Code is not installed, open the install guide from the card and install it.
3. In a terminal on that machine, run `claude auth login`. The card has the command ready to copy.
4. Select **Verify**. The card shows **Ready** and the account Claude Code is logged in with.
5. Pick a model from **Claude Agent** in a bot's settings.

You can also choose it during onboarding, from a chat whose bot needs it, or with **Add separate
account** on the Claude page. Each separate account keeps its own Claude Code login in its own
config folder (`CLAUDE_CONFIG_DIR`), so logging it in never changes the login your other bots use.
If you don't choose a folder, Akeru gives the account one in its own data folder on the
environment's machine. To use a folder you choose, set the account's config path or its
`CLAUDE_CONFIG_DIR` variable. A relative folder is read from your home folder, and the card's login
command uses the same folder. The default account's command clears `CLAUDE_CONFIG_DIR` first, so a
terminal where you logged in a separate account still logs in the default one.

If you saved `CLAUDE_CONFIG_DIR` as a hidden value, the card can't show the folder. It tells you to
set `CLAUDE_CONFIG_DIR` to that folder in your terminal yourself, then shows the login command to
run.

An account with no config folder keeps its login in Claude Code's default folder under its home. If
the account sets `HOME`, or `USERPROFILE` on Windows, the card's login command uses that home for
the login, so **Verify** checks the same login you just made. If that variable is a hidden value,
the card tells you to set it in your terminal yourself, then shows the login command to run.

Akeru never reads your Claude Code login and never passes a Claude token or API key to Claude Code.
It starts Claude Code with only basic variables such as `PATH`, `HOME`, your language settings, and
proxy and certificate settings (`HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, and similar),
so an `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, or Bedrock or Vertex switch in the environment
cannot replace or reroute your login. To run a different `claude` program, set the binary path on
the card or set `AKERU_CLAUDE_PATH`. The card's login command runs that same program.

Bots also run without your Claude Code settings files: the `env`, `apiKeyHelper`, hooks, CLAUDE.md
files, MCP servers, and skills in `~/.claude` or a project's `.claude` folder do not apply. Akeru
gives the bot its own instructions, MCP servers, and permission policy instead. Your login still
works, because Claude Code keeps it apart from settings.

The login command on the card is quoted for the environment's shell, so pasting it runs only the
login, even when the account's config folder has spaces or symbols in its name. On a Windows
environment the card shows the PowerShell form.

The card names what to fix:

- **Not installed:** install Claude Code, then log in and verify.
- **Logged out:** run `claude auth login` on that machine, then verify.
- **Needs attention:** Claude Code could not start or report its login. The card shows its reason.
  Updating with `claude update` often fixes it.

Select **Stop using Claude Agent** to remove the connection. Your API key, if you added one,
stays connected. Mobile shows each Claude Agent connection's state and the fix under **Providers**.

Bots on Claude Agent use Claude Code's own tools, plus Akeru's browser preview, image, and
memory tools and the bot's MCP servers. They follow the bot's permission policy: a denied action is
refused, and an action that asks waits for you even in **Full access**, with the exact command or
file and the reason on the approval card. For an MCP tool, the card shows every argument the bot
sent. Reading files outside the bot's workspace counts as using
your computer, writing outside it counts as an outside change, and file tools cannot open or search
Claude Code's own login and settings files. A shell command that might reach them always asks you first.
A command or tool call too long to show in full on the card is declined rather than approved
blind.

This protection is best-effort. On your own computer, a bot that can run shell commands can read
anything you can, and no check can catch every way a command names a file. Claude Code always runs
on the environment's computer, so a Claude Agent bot can only use the Local
[sandbox](./sandboxes.md). Starting one set to any other sandbox fails with a message saying so.
To keep a bot away from your files, give it another engine and a sandbox. Claude Agent bots cannot
delegate to other bots or start Akeru workers.

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
