---
"akeru-bot": patch
---

Opening a chat no longer crashes the Android app with "undefined is not a function". Mobile now sorts and reverses arrays with plain copies instead of the newer `toSorted`/`toReversed` methods the Hermes engine does not provide.
