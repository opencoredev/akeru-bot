# Plugins

Open **Plugins** from the sidebar or command palette. Browse focused sections such as **Web** and **Work**, or search by plugin name, description, or category. Select a plugin to see what it does, inspect its connector, copy its source link, or open its documentation. Choose **Add** to install it for the current environment and enable it for every bot by default. Use a bot's **Plugins** setting to disable it for that bot. Choose **Added** to disable it for the environment.

Select the installed and custom count below the title to review active plugins and custom MCP servers. Builtin plugins use their catalog configuration and do not expose transport editing. Akeru Bot stores no plugin credentials in the catalog or MCP registry. Keep credentials in the host environment or the service sign-in flow.

Hosted plugins use their public MCP URL. Context.dev, Firecrawl, and Parallel Search start browser-based OAuth. Exa works anonymously and supports optional OAuth for higher limits. Executor starts its official local MCP command through Bun and exposes integrations from the user's Executor account. Plugin details link to verified agent skills when the service publishes them. Akeru Bot does not install separate skill packages when you add an MCP connector.

Akeru adds every enabled plugin to each bot unless that bot disables it. A provider change starts a fresh provider session with the same enabled plugins. Re-enabling a builtin plugin refreshes its stored connection recipe before the next session starts.

Ask the agent to add a custom MCP server. The agent can configure a local command or remote URL for the current environment. Existing custom servers appear in the installed directory, where you can edit, disable, or delete them. Custom servers operate independently from builtin plugins.
