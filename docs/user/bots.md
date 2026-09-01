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

Settings controls whether bots share their workspace and browser. **Separate** is the default and gives each bot its own workspace identity and browser profile. **Shared** lets bots share files and cookies. Bots can use Local, E2B, Daytona, Vercel Sandbox, or Upstash Box workspaces. Remote workspaces use the provider credentials available to the environment and fail if those credentials are missing.

Local bots ask before file changes and shell commands by default. Select **Settings > General > Local execution > Full access** to skip those local prompts. Actions that send, pay, delete, change production, or use secrets still ask. Bots that run in a cloud sandbox do not show the local computer prompt.

Use the panel button to collapse or reopen the editor. The default shortcut is **Mod+Alt+B**, and you can change `Right Panel: Toggle` in the keybinding settings. On a narrow screen, the same button opens a sheet.

When a request needs tools, the bot first replies in plain language. During longer work, it adds short status notes after meaningful progress. When work resumes automatically, it continues without a repeated opening note.

Bot replies support headings, links, tables, task lists, code blocks, math, and Mermaid diagrams.

On web and desktop, a bot can link to an app setting with a chip such as `[Error inbox](grokbot://app/v1/settings?id=bot-inbox)`. The chip opens the matching Settings section and shows the destination on hover.

## Call a bot

Open **Settings → Voice** to enable voice, choose the ChatGPT subscription provider, and select a voice. Turning voice off there removes calling for every bot.

Turn on **Voice calls** for the bot, then select the phone button in its chat header. Akeru Bot uses the microphone and speaker on this computer with the connected ChatGPT subscription. New calls use the voice selected in Settings.

Only one call can run at a time. The call bar stays visible when you open another bot. Select the bar to return to the call, or select the hang-up button to end it.
