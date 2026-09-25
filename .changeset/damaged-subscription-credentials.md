---
"akeru-bot": patch
---

Saved subscription credentials changed by another process now show up without a restart. If the credential file becomes damaged while Akeru Bot is running, it keeps using the credentials it already loaded and shows a warning in Settings; a file that was damaged at startup shows a reconnect error on every provider. The next sign-in keeps the damaged file as a `.corrupt` backup.
