---
"akeru-bot": patch
---

Pre-rename `t3code/pr-<n>/<head>` worktree branches are found and reused when preparing a pull request worktree (GitHub and Bitbucket) instead of being orphaned by a fresh `akeru/pr-*` branch; mobile theme preferences persisted as `t3-code` or `t3-chat` now canonicalize to the Akeru theme ids on load.
