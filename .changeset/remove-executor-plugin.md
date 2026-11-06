---
"akeru-bot": minor
---

Remove the Executor plugin. Composio is now the only built-in connector service, and custom MCP servers still work with a local command or a remote URL. On upgrade, Akeru removes a saved Executor installation and clears it from every bot's tools; other plugins and custom servers stay as they are. To keep using an app you reached through Executor, connect it through Composio or add its MCP server under Custom MCP servers.
