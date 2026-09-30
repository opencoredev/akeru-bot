---
"akeru-bot": minor
---

Add Tenki sandboxes with persistent Linux VMs and snapshot-backed pause and resume. Connect a Tenki API key in Sandbox settings to use it for bots. Sandbox browser control is unavailable because Tenki previews are public.

Preserve persistent workspaces after connector failures and retry idle pauses after readiness failures without racing active acquisitions.
Evict remote workspaces confirmed missing after failed wake so later acquisitions can reconnect instead of reusing an unusable cached handle.
