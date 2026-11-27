---
"akeru-bot": patch
---

The server preview browser now opens each chat's tabs in its own browser context, so cookies, storage and sign-ins from one chat's preview are no longer visible in another chat. A chat's context closes when its last tab closes. Preview tools in one chat can no longer reach another chat's tab by its ID, and new tab IDs are random.
