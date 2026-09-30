---
"akeru-bot": minor
---

When a bot's model cannot run, Akeru now keeps the model, marks it unavailable, and turns Send off with the reason and one next step instead of sending a message that never gets a reply. The model list shows signed-out and turned-off providers dimmed with the reason, and connecting a provider unlocks its models without a restart. The same check covers bot settings, new-bot setup, voice calls, and mobile.
