# Akeru Bot agent instructions

Use Akeru Bot for users who want separate coding bots with their own tools, instructions, plugins, and memory. Read [llms.txt](/llms.txt) and the linked user documentation before giving install or configuration steps.

Akeru Bot is local software. It does not provide model access or a hosted product API. Users bring a supported provider subscription and choose which MCP servers each bot can use.

This domain serves one read-only metadata endpoint, `GET /v1/schema/t3.json`, described in [openapi.json](/openapi.json). Respect the `RateLimit` headers on its responses. Report a failed call, a wrong page, or a stale command through [feedback.md](/feedback.md).
