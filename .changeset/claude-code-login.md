---
"akeru-bot": minor
---

Claude bots can run on your own Claude Code login. Choose **Use your Claude Code login** on the Claude provider page, during onboarding, or from a chat that needs it. Akeru runs the Claude Code installed on the environment's machine, walks you through installing it and running `claude auth login`, and verifies the login. Akeru never reads the login, starts Claude Code with only basic environment variables and none of your Claude Code settings files, and these bots follow the bot permission policy for every tool call, including file access outside their workspace. File tools cannot open Claude Code's own login and settings, and shell commands that might reach them ask you first. This is best-effort on your own computer; run bots in a sandbox to keep them away from your files.
