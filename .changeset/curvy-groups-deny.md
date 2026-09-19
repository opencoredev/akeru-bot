---
"akeru-bot": patch
---

Improve chat responsiveness by avoiding unnecessary history reads and streaming UI updates, preparing attachments without blocking other work, and keeping independent chats and checkpoint updates moving during slow setup or search indexing. Reuse unchanged connected-tool sessions and batch internal projection progress writes without weakening persistence guarantees.
