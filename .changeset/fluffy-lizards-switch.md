---
"akeru-bot": minor
---

Add Railway bot workspaces with durable identity reattachment and saved credentials. Railway VMs remain running while idle; previews require a CLI tunnel and automatic bot browser routing is unavailable.

Block deletion of bots using Railway explicitly or through the current default with manual VM-retirement instructions. Bots inheriting Local can be deleted normally. Switching to Local allows deletion but does not verify or perform cloud cleanup.

Preserve sandbox inheritance when editing bot settings. Keep same-chat turns in order while preparing attachments without blocking other chats.
