# Channel real-service verification

This runbook is the live verification matrix for bot channels. It checks each messaging provider against a real service account, not a fake transport. Runtime tests already cover the code paths; this matrix proves credentials, delivery, restore, and repair against the vendor.

Run it whenever the channel runtime, a transport, or the health contract changes, and before marking a provider's channel work complete in a milestone.

## Isolation rules

- Always run against an isolated Akeru home. Never point the test server at `~/.akeru/userdata` or `~/.akeru/dev`, and never symlink.
- Use a dedicated test home, for example `AKERU_HOME=$(mktemp -d /tmp/akeru-channels.XXXXXX)`. To reuse real bots and projects, snapshot the database with `VACUUM INTO` as described in the project AGENTS.md test data section, and leave secrets behind. Enter fresh channel credentials in the test home.
- Use a throwaway workspace and test messaging accounts. Do not verify against workspaces, servers, phone numbers, or Slack workspaces that carry real conversations.
- A standard-scope pairing token is enough to watch chats. Managing connections under Settings > Bot channels needs an administrator session, so keep the startup pairing URL.
- Stop the test server by the PID you started, and remove the temporary home afterward.
- Evidence (screenshots, message logs, timings) goes to the tracking issue, not the repository.

## Shared checklist

Run every step for each provider unless that provider's section marks a step not applicable.

1. **Connect.** Save credentials, assign a bot and a project, and connect. The binding reaches `connected` and the card reports no error.
2. **Inbound message.** Send a message that the provider's conversation policy accepts (see the per-provider table). A new Akeru thread appears under the selected project, labeled with the channel origin.
3. **Reply.** The connected bot's final reply posts back to the same external conversation once the turn completes. No intermediate tool output reaches the channel.
4. **Delivery states.** Watch the reply in the Akeru conversation. It moves from sending to sent. To see `failed`, revoke or break the credential mid-test and retry the reply. To see `unknown`, cut the network between the send and the provider response; the attempt must not repost on its own, and the channel card must show the delivery warning with a **Check the channel** action.
5. **Thread continuation (Slack and Discord).** Reply inside the same platform thread without a new mention. The message continues the same Akeru thread.
6. **Repair.** For each health state, confirm the card offers exactly one repair action: reconnect after a dropped connection, update credentials after a rejected token, choose another project after the project is removed, set a public URL for WhatsApp `not-live`.
7. **Disconnect and reconnect.** Disconnect stops inbound delivery and clears status reactions. Reconnect resumes inbound delivery without duplicating earlier replies.
8. **Restore after restart.** Stop the server, start it again on the same home, and send another inbound message. The channel restores without a manual reconnect. Then break a credential, restart again, and confirm the binding comes back `failed` with the `restore` category and the server still starts.
9. **Authorization refusal.** Connect a standard-scope client and attempt each `channel.*` command. Every one is refused. The card must not offer repair actions the session cannot perform.
10. **Reply footer.** With a public origin configured, an external reply ends with the Open in Akeru link. Without one, no link appears.
11. **Status reactions (Slack and Discord).** The request message gains an eyes reaction on accept, an hourglass while the turn waits on an approval or answer, a check on completion, and an X on failure or cancellation.
12. **Bot-authored messages.** Messages sent by the Akeru bot itself, and by any other connected bot, never start work.

## Provider requirements and status

### Telegram

Needs: a BotFather bot token (`/newbot`). Free and the cheapest provider to verify, so run it first.

Policy notes: direct messages only. A group message must not start work. Telegram messages sent on behalf of a chat report an unknown author and are ignored only when they are explicitly marked as bot-authored.

Matrix result, 2026-09-26: **unverified: no credentials.**

### Slack

Needs: a Slack app on a test workspace.

- Socket Mode enabled.
- One app-level token with the `connections:write` scope. Akeru probes it with `apps.connections.open` before connecting; an auth failure reports invalid token, a network failure reports Slack unreachable.
- A bot token installed to the workspace.
- Bot event subscriptions: `message.im` for direct messages, `app_mention` for channel mentions, and `message.channels` so replies inside subscribed platform threads continue the Akeru thread.
- Bot scopes covering `chat:write`, `reactions:write`, `im:history`, `im:read`, `im:write`, `channels:history`, `channels:read`, and `app_mentions:read`.

Verify that a mention reply lands inside the Slack thread (`thread_ts`), not at the channel root. Socket Mode is outbound only, so no public URL is required.

Matrix result, 2026-09-26: **unverified: no credentials.**

### Discord

Needs: a Discord application and bot on a test server.

- Privileged gateway intents: enable Message Content Intent in the developer portal. The adapter requests Guilds, Guild Messages, Message Content, Direct Messages, Guild Message Reactions, and Direct Message Reactions.
- Copy the application ID, public key, and bot token into the connection form. The public key is required even though Akeru only uses the gateway.
- Invite the bot with the generated link. Its permission set covers viewing channels, sending messages, reading message history, creating and using threads, and adding reactions.

Verify that a first server mention creates a Discord thread on that message, that role mentions and @everyone do not start work, and that the supervised gateway renews across its hourly listener boundary.

Matrix result, 2026-09-26: **unverified: no credentials.**

### iMessage (Photon)

Needs: a Photon account, either hosted credentials (project ID and project secret) or a self-hosted Photon server on macOS (server URL, API key, optional phone). The hosted option can use a shared project number.

Policy notes: direct messages only, no group chats. All post errors stay ambiguous because Photon's internal retries cannot be classified; treat any failed send as unknown until the conversation confirms otherwise. The gateway listener renews hourly; keep a session running past the boundary at least once.

Matrix result, 2026-09-26: **unverified: no credentials.**

### WhatsApp

Needs: a Meta Business app with the WhatsApp Business Cloud API, a phone number ID, an access token, an app secret, a verify token, and a public HTTPS origin for the environment server (`--public-origin` or `T3CODE_PUBLIC_ORIGIN`).

- Without a public origin the binding must save as `not-live` and no webhook URL appears in the profile.
- With a public origin the server writes the webhook URL (`/api/channels/whatsapp/connections/<connection-id>/webhook`) into the connection profile. Configure that URL and the verify token in the Meta app dashboard. The older per-bot route (`/api/channels/whatsapp/<bot-id>/webhook`) still accepts calls.
- Verify Meta's GET challenge and a signed POST. An altered signature must be rejected.
- WhatsApp can accept an earlier text chunk before failing, so treat post failures as ambiguous delivery, never a confirmed rejection.

Matrix result, 2026-09-26: **unverified: no credentials.**

## Recording results

Update the matrix line for each provider with the date, the result, and a link to the evidence on the tracking issue. A provider without credentials stays `unverified`; do not mark it complete. Any defect found during the run goes back to the lane that owns the code, not into a docs commit.
