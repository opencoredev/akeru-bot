---
"akeru-bot": patch
---

Persisted-state migration helpers no longer crash when `window` exists but `localStorage` is unavailable, so modules that migrate legacy `t3code:` keys load cleanly in non-DOM environments.
