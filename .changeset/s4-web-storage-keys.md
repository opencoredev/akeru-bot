---
"akeru-bot": patch
---

Move web browser storage off the `t3code:` key prefix to `akeru:` keys, reading the legacy keys once and draining them on the next write so theme, drafts, stashes, and panel state survive the rename.
