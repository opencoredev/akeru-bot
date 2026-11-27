---
"akeru-bot": patch
---

Computer and voice controls now require a client with operate access, so a read-only client can no longer take over a bot's computer or change voice settings. Retrying or canceling bot work from a group chat, including work its bots delegated onward, now checks group membership, and a voice transcript that names a bot must name a bot that belongs to that chat. Changing the bot that answers a channel keeps the project the picker shows. `akeru pair --admin` revokes its link if an admin paired while it ran, and a pairing link that presents itself as a bot no longer keeps admin pairing open.
