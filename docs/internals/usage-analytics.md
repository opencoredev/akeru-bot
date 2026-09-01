# Usage analytics

> For maintainers. Using Akeru Bot? See [Anonymous usage analytics](../user/analytics.md).

Akeru Bot sends one PostHog event named `usage_3h` for each non-empty, closed
three-hour UTC bucket. The default destination is
`https://us.i.posthog.com/batch/`. `T3CODE_POSTHOG_HOST` changes the host and keeps
the `/batch/` path.

Packaged production builds enable analytics by default. Development and CI disable
it by default. `T3CODE_TELEMETRY_ENABLED` overrides that default for packaged,
headless, development, and CI runs.

## Payload contract

The event has 18 base counters:

- `new_installations`
- `bots_created`
- `bots_deleted`
- `bots_total`
- `user_messages`
- `bot_replies`
- `failed_turns`
- `group_messages`
- `external_messages`
- `voice_sessions`
- `browser_tasks`
- `routines_run`
- `routine_failures`
- `connector_calls`
- `connector_failures`
- `approvals_requested`
- `approvals_accepted`
- `approvals_rejected`

The schema bounds every counter. Analytics code must not add arbitrary counters or
properties.

The same fixed schema has counters for provider turns, sandbox turns, completed tool
categories, provider-native web searches by built-in adapter, and enabled public
catalog plugins. Plugin counters use reviewed catalog slugs. Unknown and custom MCP
server names, IDs, commands, arguments, and URLs never enter the event.

The server derives bots, messages, replies, failed turns, groups, approvals, provider
turns, sandbox turns, completed tool categories, and provider-native web searches
from durable orchestration events. It reads enabled catalog plugins from the local MCP
projection. External message, voice, sandbox browser, routine, and connector counters
remain zero until those features have a durable local count source.

`new_installations` is `1` in the first non-empty bucket for a new analytics UUID and
`0` afterward. It measures first active use, not a download or a person. It does not
make an otherwise empty bucket eligible to send.

The only allowed dimensions are:

- `app_version`
- `operating_system`
- `architecture`
- `client_type`
- `provider`
- `sandbox_provider`
- `bucket_start`

`bucket_start` is the UTC start time of the three-hour bucket. Empty buckets advance
the local cursor. Akeru Bot does not queue or send them.

## Identity and privacy boundary

The server creates a random analytics-only UUID. It does not read Codex, Claude, or
other provider authentication files. It does not derive the UUID from an account or
another Akeru Bot record.

The payload must never contain prompts, replies, model output, names, bot IDs,
thread IDs, workspace IDs, group IDs, account IDs, URLs, paths, recipients, memory,
connector payloads, tokens, credentials, screenshots, stack traces, error strings,
files, or arbitrary properties. It must not collect provider auth files, personal
information, user content, connector data, or IP addresses.

## Local state and delivery

The server keeps the open bucket and closed buckets that still need delivery in
local analytics state. It retains at most 256 closed buckets. If that limit is full,
the server stops closing buckets. It does not discard an older report to make room.

The server delivers at most eight closed buckets per UTC day. Each delivery attempt
also sends at most eight buckets. The server removes a bucket only after PostHog
returns a successful response. Failed sends stay local for a later retry.

Each event has a deterministic PostHog `$insert_id`. It is the lowercase SHA-256
hex digest of the random analytics UUID and `bucket_start`. PostHog can therefore
deduplicate a retry after an uncertain response.

## User control

The server setting `analyticsEnabled` is available as **Analytics** in
**Settings → General**. Turning it off immediately stops collection and deletes the
random analytics UUID, open bucket, pending buckets, and legacy analytics ID file.
The disabled setting persists. Turning analytics on later creates a new random UUID
and starts a new bucket.

This analytics path is separate from [resource telemetry](./resource-telemetry.md).
Resource telemetry supports local diagnostics and does not enter `usage_3h`.
