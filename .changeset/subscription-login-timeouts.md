---
"akeru-bot": patch
---

Subscription logins for xAI and ChatGPT no longer hang when the provider stops responding. Each login and refresh request now fails with a clear message after 30 seconds.
