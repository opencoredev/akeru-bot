# Plugins

Open **Plugins** from the sidebar or command palette. Filter by **All**, **Featured**, **Installed**,
or category. Search checks the plugin name, title, description, category, tags, capabilities, and
publisher.

## Review a plugin

Select a plugin to inspect its publisher, authentication, execution location, transport, supported
platforms, permissions, approval classes, setup, documentation, source, and dependent bots.

Health stays **Not checked** until a real request succeeds. An enabled plugin is not proof that its
connection works. A routine can require an enabled connector.

## Plugin actions

- **Add** installs a public or local plugin.
- **Connect** starts OAuth.
- **Add key** stores a required key in the host environment.
- **Disable** stops the plugin without deleting it.
- **Reconnect** repairs a failed OAuth connection or enables a disabled plugin.
- **Remove** deletes the registration.

A plugin waiting for publisher approval stays visible, but **Connect** remains disabled. A plugin
removed from the public directory stays under **Installed** until you remove it.

## Enable tools for a bot

Akeru enables a new plugin for every bot by default. Open the bot's **Tools** setting to disable it
for that bot. Changing the bot's provider starts a fresh provider session with the same enabled tools.

## Composio integrations

Gmail appears as a normal plugin with a **Composio** provider badge. Select **Connect**, then enter a
Composio API key. Akeru opens Composio's hosted sign-in page for the Gmail account.

Get a key from [Composio API keys](https://app.composio.dev/settings/api-keys). You can also save or
replace the key under **Settings > Plugins**. Akeru stores the key on the environment server, not in
the plugin catalog or MCP registry.

Connect more than one Gmail account when you need separate work and personal accounts. Manage each
account under **Settings > Plugins**. The bot asks you to select an account when a tool call could
use more than one.

Composio tools work in chats opened from web, desktop, or mobile after an environment has a key and
at least one connected account. Configure accounts from the web or desktop client.

## Custom MCP servers

Use **Add server** under **Custom MCP servers** when a connector is not in the directory. Installed
servers can be edited, disabled, or removed from the same section.

Akeru does not store plugin credentials in the public directory or MCP registry. Keep credentials in
the environment server or the service's sign-in flow.

## Codex Computer Use

Codex Computer Use runs only on the local Mac. It does not use a hosted desktop. macOS requests
Screen Recording and Accessibility access when the helper needs them.

Only one bot can control the Mac at a time. **Stop** ends the current session. **Revoke** ends it and
disables Computer Use for every bot. Akeru excludes screenshots, typed text, window titles, and app
content from stored runtime events.
