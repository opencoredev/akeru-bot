---
"akeru-bot": minor
---

Channel replies now show where they came from and whether they were delivered. Web and mobile thread views render the external origin on inbound channel messages and a per-reply delivery state (sending, sent, failed, or unknown) on the bot's answer. When the environment advertises a public origin (`--public-origin` or `T3CODE_PUBLIC_ORIGIN`), external replies end with an "Open in Akeru" link to the bot.
