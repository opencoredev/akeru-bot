# Anonymous usage analytics

Akeru Bot sends anonymous usage totals from packaged production builds. Development
and CI runs do not send analytics unless a maintainer enables them.

Each report covers one three-hour UTC period. It contains counts for bots, messages,
bot replies, failed turns, groups, approval decisions, provider turns, sandbox turns,
completed tool categories, and provider-native web searches. It also records which
public catalog plugins are enabled. Custom plugin names and MCP server details never
leave the installation.

The first report with activity marks the analytics installation as new. This supports
an anonymous new-active-install trend. It does not identify a person or count a
download that never runs.
Reserved counters for external messages, voice, browser tasks, routines, and
connectors stay at zero until those features have a durable local count source.

Akeru Bot uses a random UUID only for analytics. It does not read provider sign-in
files or use an account ID. Reports do not contain personal information, user
content, connector data, IP addresses, prompts, replies, model output, personal IDs,
URLs, paths, recipients, memory, payloads, tokens, credentials, screenshots, stack
traces, error text, files, or custom properties.

Turn off **Analytics** in **Settings → General** to stop collection. Akeru Bot then
deletes the analytics UUID, the current period, all reports waiting to send, and the
legacy analytics ID file. The setting stays off.

Resource diagnostics are separate. [Local resource telemetry](../internals/resource-telemetry.md)
measures processes and host resources for the diagnostics interface. It does not
send those measurements as anonymous usage analytics.
