# Codex

Akeru runs Codex models through its built-in Mastra-based runtime. Connect a ChatGPT subscription in
Akeru. You do not need the Codex CLI for Akeru bot turns.

## Connect ChatGPT

1. Open **Settings > Providers**.
2. Find **ChatGPT** and select **Connect**.
3. Open the sign-in page and enter the displayed device code.
4. Approve access with the ChatGPT account that this environment should use.
5. Return to Akeru and wait for the account status to update.

Akeru supports ChatGPT Plus, Pro, Business, Enterprise, and Edu. Select **Check OAuth** to test the
stored login. Use **Reconnect** after an expired or revoked login.

## How Codex runs

Akeru creates and controls the Codex session. The runtime supplies:

- the bot's local or remote workspace
- installed plugins and MCP tools
- Akeru memory and bot tools
- the selected permission mode
- the selected ChatGPT subscription model

Akeru normalizes tool calls, approvals, usage, messages, and errors before it sends them to the
client. This keeps the same thread controls available on web, desktop, and mobile.

The environment server stores the subscription credential under its private secrets directory. It
passes short-lived access to the runtime when needed. The credential does not enter the project,
thread history, checkpoints, or client storage.

## Protected actions

The runtime can allow routine reads and edits based on the thread's permission mode. It still asks
before an action that sends data, pays, deletes, changes production, publishes, exposes secrets,
signs, refunds, or changes an account. An approval applies only to the pending action.

See [Permission modes](./permission-modes.md) for the complete mode behavior.

## Fix sign-in problems

If Codex cannot start:

1. Open **Settings > Providers**.
2. Check the ChatGPT status.
3. Select **Check OAuth**.
4. Select **Reconnect** if the check fails.
5. Confirm that the account has a supported ChatGPT plan.

Repeat these steps on the environment that owns the project. Signing in on another Akeru server does
not connect this one.
