---
"akeru-bot": patch
---

Supervised and Auto-accept edits chats now ask before a bot runs a command or takes another action its permission policy leaves to the chat mode, including in cloud sandboxes, unless the policy explicitly allows that tool. Reads still run without asking. Claude Agent bots also protect more spellings of Claude Code's own files, a Claude Agent bot moved to a remote sandbox no longer takes new messages on this computer, a permission mode change made while a bot finishes work before a workspace move now refuses new messages until that work is done (a tightened mode stops the running session), and an OpenCode chat that reconnects after a restart refuses its next message until a session with the bot's permission check starts.
