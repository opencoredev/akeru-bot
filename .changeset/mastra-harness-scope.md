---
"akeru-bot": patch
---

Server shutdown gives observational memory work a few seconds to finish instead of hanging on a stuck observation, and unfinished observations carry over to the next start. A failed memory import restore now says whether the original observations were kept.
