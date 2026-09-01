# Anonymous usage analytics

Packaged production builds send anonymous aggregate usage by default. Development and CI builds do
not send it unless a maintainer enables it.

## What a report contains

Each report covers one three-hour UTC period. It contains fixed counters for:

- created, deleted, and active bots
- user messages, bot replies, group messages, and failed turns
- approval decisions and provider turns
- local and remote sandbox turns
- completed tool categories and provider-native web searches
- supported external messages, voice calls, browser work, routines, and connectors
- public catalog plugins that are enabled

Counters with no durable local source stay at zero. Custom plugin names and Custom MCP server details
never leave the environment.

The first report with activity marks the installation as new. This measures active installations. It
does not count a download that never runs.

## What a report excludes

Reports do not contain prompts, replies, model output, files, paths, URLs, recipients, memory,
screenshots, stack traces, error text, tokens, credentials, or provider account identifiers.

Akeru uses a random analytics UUID. It disables PostHog person profiles and geolocation for these
events. It also supplies a fixed empty IP value instead of the client address.

## Turn analytics off

Open **Settings > Privacy** and turn off **Anonymous analytics**. Mobile uses the same path.

Turning analytics off deletes the analytics UUID, the current period, queued reports, and the legacy
analytics ID file. The setting stays off.

Resource diagnostics are separate. [Local resource telemetry](../internals/resource-telemetry.md)
measures the environment for the diagnostics interface and does not send those measurements as
anonymous analytics.
