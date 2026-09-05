# Bot channels

A channel gives one named bot an external messaging line. Messages enter the bot's normal Akeru thread. The bot uses its selected project, model, tools, memory, permission mode, usage limits, and delegation rules.

Akeru does not create a separate messaging session. The Akeru thread is the durable conversation, and each external request starts a turn.

## Manage connections

Open **Settings > Bot channels** with an environment administrator connection.

1. Select a provider.
2. Save the provider credentials under a connection name.
3. Select the project that the bot will use.
4. Assign the connection to one bot.

Select a project before assigning a new connection. Akeru does not choose the first project for you.

You can reconnect, disconnect, unassign, or delete a connection. Disconnect stops messages but keeps the bot and project assignment. Unassign removes that assignment so you can use the connection with another bot or delete it. A connection that fails during server restart shows a repair state instead of appearing connected.

After you move a connection to another project, replies from its earlier project cannot use the new assignment.

Credentials stay on the environment server. Web, desktop, and mobile receive safe connection and delivery state only. A standard remote client cannot change channel credentials or assignment.

## Delivery state

Akeru records confirmed replies and prevents normal retries from posting them again. If a provider confirms that it rejected a reply, you can retry that reply.

A network failure can leave delivery unknown. Akeru keeps that attempt and does not post it again automatically. Settings and the bot's Channels panel show a warning. Check the external conversation before taking further action. Reconnecting does not prove whether the earlier reply arrived.

Mobile shows channel health, the selected project, recent confirmed deliveries, and a warning when a channel needs attention. Recent delivery counts cover retained confirmations, not the channel's full history.

## Status signals

On Slack and Discord, the bot marks your request message with a reaction: an eyes reaction when it accepts the request, a check mark on success, and an X on failure or cancellation. Akeru removes stale reactions when a connection restores or closes. Telegram, iMessage, and WhatsApp do not support these reactions and receive no status signal. Detailed progress stays inside Akeru; the channel never receives a stream of tool output.

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

Delegated bots do not send separate external replies. The connected bot returns one combined answer through the original channel.

## Telegram

Create a bot with BotFather and copy its token. Save the token in the Telegram connection form, select a project, and assign the connection to a bot. Send a direct message to the Telegram bot to test it.

## iMessage

Akeru uses Photon for iMessage. You can use Photon hosted credentials or a self-hosted Photon server. Save the connection, select a project, and assign it to a bot. Send a direct iMessage to the connected line.

External iMessage group chats are not supported.

## WhatsApp

Akeru uses the WhatsApp Business Cloud API. The connection needs an access token, app secret, phone number ID, and verify token. Configure Meta to send webhook requests to `https://<server>/api/channels/whatsapp/<bot-id>/webhook`. Replace `<server>` with your environment server's public hostname. Replace `<bot-id>` with the identifier after `/bots/` in the bot's web address.

WhatsApp must be able to reach the environment server over public HTTPS. If the environment has no public address, the WhatsApp connection cannot receive webhooks.

## Slack

Create a Slack app for one workspace.

1. Enable Socket Mode.
2. Create an app-level token with the Socket Mode connection scope.
3. Install the app and copy the bot token.
4. Subscribe the app to direct-message and mention events.
5. Save the bot token and app-level token in Akeru.
6. Select a project and assign the connection to a bot.

Socket Mode uses an outbound connection from the environment server. It works when Akeru runs locally, over SSH, or through Tailscale without a public webhook URL.

The Slack channel connection is separate from the Slack plugin. The connection receives messages for a bot. The plugin gives a bot Slack tools. They do not share credentials or connection state.

## Discord

Create a Discord application and bot. Enable Message Content Intent, then copy the application ID, public key, and bot token. Invite the bot with permission to view channels, send messages, read message history, create or use threads, and add reactions.

Save the credentials in Akeru, select a project, and assign the connection to a bot. Direct messages reach the bot. A direct mention in a server starts work in the linked Discord conversation.

## Access warning

Anyone who can reach a connected bot can ask it to use the selected project and its enabled tools. The bot's permission mode still controls sensitive work, but channel membership is part of the access boundary.

Keep Slack bots out of channels that should not reach the workspace. Limit Discord server and channel access. Use a private phone or messaging identity for Telegram, iMessage, and WhatsApp when the selected project contains sensitive data.
