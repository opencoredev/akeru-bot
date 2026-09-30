---
"akeru-bot": patch
---

`akeru pair` now prints expected errors like an invalid `--public-url` or an already-paired admin as a single message instead of an ERROR line with a stack trace. Remote health formats storage in human-readable units, and a missing optional account link no longer reports as a warning. Settings > Connections now states that a localhost-only server can be reached through Tailscale Serve (`akeru pair --tailscale`) or a restart with a reachable `--host`.
