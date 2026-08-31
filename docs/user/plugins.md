# Plugins

Open **Plugins** from the sidebar or command palette. Use **All**, **Featured**, **Installed**, or one of the eight categories. Search checks the plugin name, description, category, tags, capabilities, publisher, permissions, approvals, platforms, connection details, and other catalog information.

Select a plugin to review its publisher, authentication, hosted or local execution, transport, platform support, permissions, approval classes, setup, documentation, and source. Health shows **Not checked** until Akeru completes a real request. An enabled plugin does not imply a healthy connection.

The available action matches the current state:

- **Add** installs a public or local plugin.
- **Connect** starts an OAuth connection.
- **Add key** installs a plugin whose key stays in the host environment.
- **Disable** stops an enabled plugin without deleting its registration.
- **Reconnect** refreshes and enables a disabled plugin.
- **Remove** deletes the plugin registration.

Approval-pending plugins remain visible, but Akeru disables **Connect** and shows the vendor blocker. Plugins removed from the directory remain under **Installed** until you remove them.

Akeru enables each installed plugin for every bot by default. Use a bot's **Plugins** setting to disable it for that bot. A provider change starts a fresh provider session with the same enabled plugins.

Ask the agent to add a Custom MCP server when a connector is not in the directory. Existing Custom MCP servers remain under **Installed**, where you can edit, disable, or delete them. Akeru stores no plugin credentials in the directory or MCP registry. Keep credentials in the host environment or the service sign-in flow.
