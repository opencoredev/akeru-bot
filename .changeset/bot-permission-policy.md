---
"akeru-bot": minor
---

Each bot now has one permission policy that decides whether a built-in tool call or routine change may run, must ask you first, or is refused, based on how far the action reaches and who the bot is working for. Bots now always ask before recognized deletions, sends, payments, deploys, and secret reads, including commands like `git clean -fd` in a cloud workspace that ran without asking before. Approvals now apply only to the exact action you saw, take one answer, and expire after 24 hours. Full access and Auto review cannot answer an approval the policy reserves for you, and a bot checks its permissions again right before the approved action runs.
