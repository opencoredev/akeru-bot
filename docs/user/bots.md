# Configure bots

Open a bot to edit its profile in the panel beside the conversation.

- Select the avatar to change its shape, color, generated image, or uploaded image.
- Set the bot name.
- Add an optional label and description.
- Choose the model that the bot uses.
- Turn on **Voice calls** to show the phone button in that bot's chat header.
- Open **Tools** to choose which installed plugins and MCP servers the bot can use. New tools are enabled for every bot by default.
- Select **Save** to apply profile, model, voice, and tool changes.

Akeru Bot stores the profile in the connected environment. Other clients connected to the same environment see the same bot configuration. Workspace-disabled tools stay unavailable to all bots.

Use the panel button to collapse or reopen the editor. The default shortcut is **Mod+Alt+B**, and you can change `Right Panel: Toggle` in the keybinding settings. On a narrow screen, the same button opens a sheet.

Bot replies support headings, links, tables, task lists, code blocks, math, and Mermaid diagrams.

A bot can link to an app setting with `[Error inbox](t3code://app/v1/settings?id=bot-inbox)`.
Web and desktop show a chip and its destination. Mobile opens Error inbox and Local execution links
for the environment that owns the thread.

Failed connector requests and pending approvals appear above the bot composer and in **Settings →
Errors**. Select **View details** above the composer to see the failed task and the next action.

## Call a bot

Open **Settings → Voice** to enable voice, choose the ChatGPT subscription provider, and select a voice. Turning voice off there removes calling for every bot.

Turn on **Voice calls** for the bot, then select the phone button in its chat header. Akeru Bot uses the microphone and speaker on this computer with the connected ChatGPT subscription. New calls use the voice selected in Settings.

Only one call can run at a time. The call bar stays visible when you open another bot. Select the bar to return to the call, or select the hang-up button to end it.
