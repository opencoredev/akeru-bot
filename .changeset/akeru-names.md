---
"akeru-bot": minor
---

The server now reads `AKERU_*` environment variables, with the `T3CODE_*` names kept as fallbacks. The background service is now `akeru-bot.service` (systemd) or `dev.leodoes.akeru.service` (launchd); installing it retires an older Akeru-installed `t3code.service` unit. Provider requests now identify the app as Akeru Bot.
