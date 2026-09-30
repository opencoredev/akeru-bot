---
"akeru-bot": patch
---

Bots now fail before a turn starts when their saved model is no longer advertised by the provider instance, instead of surfacing a mid-turn transport error. The chat work log also shows a "Model rerouted" note when a provider reports answering with a different model than requested.
