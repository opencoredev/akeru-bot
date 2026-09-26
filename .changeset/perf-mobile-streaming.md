---
"@t3tools/web": patch
---

Smoother streaming in chats: bot replies update the conversation once per batch instead of once per token, and typing a message no longer re-renders the whole chat.
