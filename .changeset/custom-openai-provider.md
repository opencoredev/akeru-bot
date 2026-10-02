---
"akeru-bot": minor
---

Add a Custom API provider that runs bots on any OpenAI-compatible endpoint. When you add one, pick OpenRouter, Groq, Together AI, DeepSeek, Mistral, Fireworks, LM Studio, Ollama, vLLM, or Other; a preset fills in the base URL and name. Paste a key into the API key field, which stores it as a secret. The model list comes from `{baseUrl}/models`, and model names you add by hand are kept. Several instances can run side by side, such as a local server and a hosted gateway.
