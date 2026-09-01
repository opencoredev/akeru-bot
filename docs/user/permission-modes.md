# Permission modes

A permission mode controls which actions an agent can take before it must ask you.

The mode is set per thread, from the mode control in the message composer. Changing it in one
thread does not change any other thread. A thread created from inside another thread keeps that
thread's mode. Otherwise, new threads use **Settings > General > Local execution** and use
**Auto review** by default.

## The modes

**Supervised** asks before commands and file changes. Work outside the workspace stays restricted.

**Auto-accept edits** allows file edits and asks before commands and other actions.

**Auto** allows routine actions and asks before risky ones. Each provider maps this mode to its own
permission system. A provider without an equivalent can fall back to supervised behavior.

**Full access** allows routine commands and edits without local prompts. The agent still asks its own
questions and still stops at protected actions.

## Protected actions

Questions never need approval. A question with choices shows those choices inline. A free-text
question uses the message composer for the answer.

Akeru's Codex and Kimi runtime always asks before an action that sends data, pays, deletes, changes
production, publishes, exposes secrets, signs, refunds, or changes an account. Unknown mutating
actions also ask. Each approval applies only to the pending action.

Installed MCP tools ask unless the server marks the tool read-only. Provider adapters can add their
own approval rules.

## Choose a mode

Use **Supervised** for an unfamiliar task or a repository where an unwanted command is expensive.

Use **Auto-accept edits** when you want the refactor but still want to inspect shell commands.

Use **Full access** for a worktree or sandbox that you can restore. Check the workspace and Git diff
after the agent finishes.

Web, desktop, and mobile use the same four labels.
