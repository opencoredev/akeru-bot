# Plugins

Open **Plugins** from the sidebar or command palette. Filter by **All**, **Featured**, **Installed**,
or category. Search checks the plugin name, title, description, category, tags, capabilities, and
publisher.

## Review a plugin

Select a plugin to inspect its publisher, authentication, execution location, transport, supported
platforms, permissions, approval classes, setup, documentation, source, and dependent bots.

Health stays **Not checked** until a real request succeeds. An enabled plugin is not proof that its
connection works. A routine can require an enabled connector.

Entries marked **Verification pending** cannot be connected yet. The directory shows the vendor's
official recipe and the named blocker so the entry can be re-verified; plugins only become available
after a real install, connect, use, disable, reconnect, and remove lifecycle passes.

## Plugin actions

- **Add** installs a public or local plugin.
- **Connect** starts OAuth.
- **Add key** stores a required key in the host environment.
- **Disable** stops the plugin without deleting it.
- **Reconnect** repairs a failed OAuth connection or enables a disabled plugin.
- **Remove** deletes the registration.

A plugin waiting for publisher approval stays visible, but **Connect** remains disabled. A plugin
removed from the public directory stays under **Installed** until you remove it.

If a service adds permissions after you first connected, select **Reconnect**. Akeru renews an
outdated automatic OAuth client registration before opening sign-in, so services such as Hoplite
can request their current permissions. You may need to approve those permissions again. Manually
configured OAuth clients keep their existing registration.

## Enable tools for a bot

Akeru enables a new plugin for every bot by default. To turn one off for a single bot, open the
bot's settings and go to **Tools**. Each tool shows its connection status and a switch. Select
**Save** to apply the change. Changing the bot's provider starts a fresh provider session with the
same enabled tools.

## Composio integrations

Composio connects apps such as Slack, Notion, or GitHub through your own Composio account. Akeru
holds no vendor OAuth credentials: you bring a Composio API key, and Composio runs each app's
sign-in.

1. Get a key from [Composio API keys](https://app.composio.dev/settings/api-keys).
2. In **Plugins**, under **All** or **Installed**, paste it into the **Composio** section and select
   **Save key**. Akeru stores the key on the environment server, not in the plugin catalog or MCP
   registry.
3. Type at least two letters in the search field. Matching apps appear under **From Composio**.
4. Select **Connect**. Composio's sign-in opens in your browser. When you come back, the account
   appears in the **Composio** section.

Each account shows its state, such as **Connected**, **Waiting for sign-in**, or **Expired**, and has
its own **Disconnect**. Use **Replace key** to swap keys, or **Remove key** to stop bots from using
Composio apps. Without a key, the section says so and search shows no Composio apps.

Gmail appears as a normal plugin with a **Composio** provider badge, but its connection lifecycle is
still verification-pending. **Connect** stays unavailable, and Composio search does not offer Gmail
either, until that lifecycle is verified.

Connect more than one account for an app when you need separate work and personal accounts. The bot
asks you to select an account when a tool call could use more than one.

Composio tools work in chats opened from web, desktop, or mobile after an environment has a key and
at least one connected account. Manage the key and accounts from the web or desktop client; the
mobile app does not manage plugins.

## Custom MCP servers

Use **Add server** under **Custom MCP servers** when a connector is not in the directory. Installed
servers can be edited, disabled, or removed from the same section.

Bots can also save short guidance for an MCP server, such as which tool
to try first. Ask the bot to set it. The bot asks for approval, and the guidance applies to every
bot that uses the server from the next message on. Guidance can be up to 4,000 characters. Ask the bot to clear it to
remove it. Editing the server keeps its guidance.

When a bot removes an MCP server for you, it reports which bots were using it and lose access.

Akeru does not store plugin credentials in the public directory or MCP registry. Keep credentials in
the environment server or the service's sign-in flow.

## Codex Computer Use

Codex Computer Use runs only on the local Mac. It does not use a hosted desktop. macOS requests
Screen Recording and Accessibility access when the helper needs them.

Only one bot can control the Mac at a time. **Stop** ends the current session. **Revoke** ends it and
disables Computer Use for every bot. Akeru excludes screenshots, typed text, window titles, and app
content from stored runtime events.
