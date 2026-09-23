---
"akeru-bot": patch
---

Scoped durable memory exports now return only the selected partition, and the Memory settings actually gate durable memory: turning Memory off stops facts from being supplied to bots and blocks new writes, and turning Private bot memory off withholds each bot's private notes and facts, prevents new bot-private saves, and still lets you list, forget, or delete the existing ones.
