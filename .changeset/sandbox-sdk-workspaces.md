---
"akeru-bot": minor
---

Bot sandboxes now run through Sandbox SDK, and Boat and Local Docker join the sandbox list. Akeru saves a new sandbox's ID before anything else can fail, so a failed setup or cleanup no longer loses track of a running VM.
