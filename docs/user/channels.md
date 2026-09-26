# Bot channels

A channel gives one named bot an external messaging line. Messages enter the bot's normal Akeru conversation. The bot uses its workspace, model, tools, memory, permission mode, usage limits, and delegation rules.

Akeru does not create a separate messaging session. The Akeru conversation keeps the work history, and each external request starts a turn.

## Manage connections

Open **Settings > Bot channels** with an environment administrator connection.

1. Select a service and open its setup form.
2. Enter the credentials and a connection name.
3. Select the bot that answers, choose a project, and click **Connect**.

Select **Connect later** to save a connection without assigning a bot. You can assign it from the saved connection card.

Choose the project that should receive this channel's turns when you connect the bot. Akeru suggests the project the bot used most recently, but you can pick any project. It keeps replies in that project, so messages cannot silently move between workspaces. **Connect** stays unavailable until a project is selected. If the environment has no projects yet, the form asks you to add one first.

To move a working channel, pick another project on its card in **Settings > Bot channels** or in the bot's Channels panel, then click **Move to this project**. Akeru restarts the channel in the new project. If the move fails, the channel keeps running in its earlier project.

You can reconnect, disconnect, unassign, or delete a connection. Disconnect stops messages but keeps the bot and project assignment. Unassign removes that assignment so you can use the connection with another bot or delete it. A connection that fails during server restart shows a repair state instead of appearing connected.

If reassignment changes the workspace, replies from the earlier workspace cannot use the new assignment.

Credentials stay on the environment server. Web, desktop, and mobile receive safe connection and delivery state only. A standard remote client cannot change channel credentials or assignment.

## Channel health

Each channel card shows whether the channel is working. When something is wrong, the card explains it and offers one repair button.

- **Connecting…** appears while Akeru starts the channel. It changes to connected or to an error when the start finishes.
- **Needs reconnect** means the channel stopped after it was working, for example after a server restart or a dropped Discord or iMessage connection. Click **Reconnect** to resume.
- **Connection failed** means the provider rejected the connection or Akeru could not reach it. If the provider rejected the credentials, click **Update credentials**. Otherwise click **Reconnect**.
- **Not live** means WhatsApp cannot receive messages because the environment has no public HTTPS address. The card shows the webhook URL when the server knows it. Give the environment a public URL, then reconnect.
- **Choose another project** means the channel's project is unavailable.
- **Disconnected** means someone stopped the channel. Click **Connect** to start it again.

A connected channel can show **Needs attention** while it keeps working. If you reconnect with a token the provider rejects, the channel keeps running on its earlier connection and the card offers **Update credentials**. After a network or restart problem, the card offers **Reconnect**. If a reply's delivery is unknown, the card offers **Check the channel**, which opens the provider's console so you can see whether the reply arrived. If the connection has also failed, **Reconnect** remains available even when there is no provider console link. Reconnecting does not confirm whether the earlier reply arrived, so the warning remains.

**Update credentials** in Settings opens the setup form for that connection. Enter the new credentials and click **Save and reconnect**. Akeru connects with the new credentials and removes the old ones only after that works. If the new credentials fail, Akeru puts the earlier connection back. If the old connection is removed but its listener does not stop cleanly, the form says the bot is now unassigned from the channel. Click **Reconnect** there to connect with the new credentials. The bot's Channels panel sends you to Settings for this step.

A messaging account can answer for only one bot. If you connect an account that another bot already uses, Akeru says so. Unassign the account from that bot, then connect again.

Status changes reach every open client without a refresh.

Error text comes from Akeru, not from the messaging service. Service error messages can contain tokens or account details, so Akeru never shows or logs them.

## Delivery state

Akeru records confirmed replies and prevents normal retries from posting them again. If a provider confirms that it rejected a reply, you can retry that reply.

A network failure can leave delivery unknown. Akeru keeps that attempt and does not post it again automatically. Settings and the bot's Channels panel show a warning. Check the external conversation before taking further action. Reconnecting does not prove whether the earlier reply arrived.

Mobile shows channel health, the selected project, recent confirmed deliveries, and a warning when a channel needs attention. When a channel needs a new project, mobile tells you to repair it from Settings > Bot channels on the host; only an administrator session can reconnect a channel. Recent delivery counts cover retained confirmations, not the channel's full history.

## Status signals

On Slack and Discord, the bot marks your request message with a reaction: an eyes reaction when it accepts the request, an hourglass while it waits for your approval or answer inside Akeru, a check mark on success, and an X on failure or cancellation. Akeru removes stale reactions when a connection restores or closes. Telegram, iMessage, and WhatsApp do not support these reactions and receive no status signal. Detailed progress stays inside Akeru; the channel never receives a stream of tool output.

## Conversation behavior

| Provider | Supported conversations                                            |
| -------- | ------------------------------------------------------------------ |
| Telegram | Direct messages                                                    |
| iMessage | Direct messages                                                    |
| WhatsApp | Direct messages                                                    |
| Slack    | Direct messages and direct mentions in Slack threads               |
| Discord  | Direct messages and direct mentions in Discord servers and threads |

A group message on Telegram, iMessage, or WhatsApp does not start Akeru work.

For Slack and Discord, a direct mention starts a linked Akeru thread. Later replies in that platform thread continue the same Akeru thread without another mention. Akeru includes a small amount of recent platform-thread context with the first mention.

## Delegation

The connected bot remains the external conversation owner. It can send work to another Akeru bot or group. Delegated work follows the existing access, memory, usage, depth, concurrency, and approval limits.

Delegated bots do not send separate external replies. The connected bot replies first. When delegated work finishes, the connected bot uses the result in its reply to the next message. See [Work sent to other bots](chats.md#work-sent-to-other-bots).

## Telegram

Create a bot with BotFather and copy its token. Enter the token in the Telegram connection form, select a bot, and click **Connect**. Send a direct message to the Telegram bot to test it.

## iMessage

Akeru uses Photon for iMessage. You can use Photon hosted credentials or a self-hosted Photon server. Enter the connection details, select a bot, and click **Connect**. Send a direct iMessage to the connected line.

External iMessage group chats are not supported.

## WhatsApp

Akeru uses the WhatsApp Business Cloud API. The connection needs an access token, app secret, phone number ID, and verify token.

WhatsApp must be able to reach the environment server over public HTTPS. Start the server with a public HTTPS origin, for example `--public-origin https://akeru.example.com`. Configure Meta to send webhook requests to `https://<server>/api/channels/whatsapp/<bot-id>/webhook`, using your verify token. Replace `<server>` with that public hostname. Replace `<bot-id>` with the identifier after `/bots/` in the bot's web address.

Without a public origin, the connection saves as **Not live**: replies can still be sent, but WhatsApp cannot deliver new messages to Akeru. Restart the server with a public origin and reconnect to go live.

## Slack

Create a Slack app for one workspace.

1. Enable Socket Mode.
2. Create an app-level token with the Socket Mode connection scope.
3. Install the app and copy the bot token.
4. Subscribe the app to direct-message and mention events.
5. Save the bot token and app-level token in Akeru. Akeru checks the app-level token before it connects. If Slack rejects the token, Akeru reports an invalid token. If Slack cannot be reached, Akeru says so and leaves the token alone, so you can retry once the network is back.
6. Select a bot and click **Connect**.

Socket Mode uses an outbound connection from the environment server. It works when Akeru runs locally, over SSH, or through Tailscale without a public webhook URL.

The Slack channel connection is separate from the Slack plugin. The connection receives messages for a bot. The plugin gives a bot Slack tools. They do not share credentials or connection state.

## Discord

Create a Discord application and bot. Enable Message Content Intent, then copy the application ID, public key, and bot token. Invite the bot with permission to view channels, send messages, read message history, create or use threads, and add reactions.

Enter the credentials in Akeru, select a bot, and click **Connect**. Direct messages reach the bot. A direct mention of the bot in a server starts a Discord thread on that message and continues the work there. Role mentions and @everyone do not start work.

## Access warning

Anyone who can reach a connected bot can ask it to use the selected project and its enabled tools. The bot's permission mode still controls sensitive work, but channel membership is part of the access boundary.

The setup form repeats this warning before you click **Connect**.

Keep Slack bots out of channels that should not reach the workspace. Limit Discord server and channel access. Use a private phone or messaging identity for Telegram, iMessage, and WhatsApp when the selected project contains sensitive data.

If the selected project is removed, the channel pauses and shows **Choose another project**. To repair it, pick a project on the channel card in Settings or in the bot's Channels panel and click **Reconnect in this project**. On mobile, the chat's Channels section points you to Settings > Bot channels on the host. Messages resume once the channel reconnects.
