---
"akeru-bot": minor
---

Add a Custom API provider that runs bots on any OpenAI-compatible endpoint. Settings > Providers takes a base URL, lists the endpoint's models from `{baseUrl}/models`, and keeps any model names you add by hand. Endpoints that need a key read it from the instance's `CUSTOM_OPENAI_API_KEY` environment variable, which is stored as a secret. Multiple instances are supported, so a local server (Ollama, llama.cpp, LM Studio) and a hosted gateway can both be configured at once.
