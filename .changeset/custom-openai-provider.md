---
"akeru-bot": minor
---

Add a Custom API provider that runs bots on any OpenAI-compatible endpoint. Settings > Providers takes a base URL and an optional API key, lists the endpoint's models from `/v1/models`, and keeps any model names you add by hand. Multiple instances are supported, so a local server (Ollama, llama.cpp, LM Studio) and a hosted gateway can both be configured at once, with per-instance environment variables available for keys you would rather keep out of the settings file.
