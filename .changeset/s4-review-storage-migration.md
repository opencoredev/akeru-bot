---
"akeru-bot": patch
---

Make web storage migrations loss-free: localStorage legacy keys are removed only after the new write succeeds, and the `t3code:connection-runtime` IndexedDB database is copied store-by-store into `akeru:connection-runtime` before the old database is retired.
