---
"akeru-bot": patch
---

Regenerating a worktree branch for a thread on a legacy `t3code/<token>` branch no longer produces `akeru/t3code/...`; a shared `stripWorktreeBranchPrefix` helper removes either app-managed prefix before the new fragment is applied.
