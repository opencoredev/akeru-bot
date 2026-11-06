---
"akeru-bot": patch
---

Remote file appends no longer risk two sessions writing at once after a lock is cleared, and a lock that stays held reports a clear error instead.
