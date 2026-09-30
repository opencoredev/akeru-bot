---
"akeru-bot": patch
---

Channel reply delivery no longer stays on "Sending" forever after a restart or a storage hiccup. On startup, interrupted sends reconcile to "unknown" instead of sending forever, and a post that landed before a storage failure now records "sent".
