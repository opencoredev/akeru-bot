---
"akeru-bot": patch
---

Faster chats on busy environments: the server no longer reloads the whole database when a bot session starts or a checkpoint is captured, and it stops re-reading secrets while a bot is replying.
