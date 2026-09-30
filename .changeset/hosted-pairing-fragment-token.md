---
"@akeru/web": patch
---

Hosted pairing links only pair when the token is in the link's fragment. A link that sends the token in the query string is refused.
