# Configure bots

Open a bot, then use the panel beside the conversation to edit it.

## Profile

You can change the bot's avatar, name, label, description, model, voice access, and enabled tools.
Select **Save** to apply the changes.

Set **Token hard stop** to interrupt the current step when it reaches the selected limit. A settled
reply shows its engine, step tokens, and estimated USD cost when the provider reports enough usage
data.

Akeru stores bot profiles on the connected environment. Every client connected to that environment
sees the same profile.

## Workspaces and browsers

**Separate** is the default. Each bot gets its own workspace identity and browser profile. **Shared**
lets bots share files and browser cookies.

Bots can use Local, E2B, Daytona, Vercel Sandbox, or Upstash Box. Connect remote services under
**Settings > Sandbox**. A bot-specific sandbox overrides the environment default.

Local bots use **Auto review** by default. Safe actions continue without a prompt. Actions that send,
pay, delete, change production, use secrets, or have unclear intent still ask. Select **Settings >
General > Local execution** to ask before each local change or grant full access. Bots that run in a
cloud sandbox do not show the local computer prompt.

## Run a routine

Open **Routines** in the bot panel. Add a routine, procedure, schedule, timezone, required skills,
and connectors. Run a dry run and approve the procedure before you enable its schedule.

The panel shows the next and last run, latest result or failure, and five recent attempts. You can
run, pause, resume, edit, or delete the routine. A procedure change needs approval again.

If a required connector, provider, bot, or workspace is unavailable, Akeru pauses the routine and
adds one item to the bot inbox. Fix the dependency, then resume the routine. Restoring an archived
bot does not resume its routines.

## Tools

Open **Tools** in the bot editor to enable or disable installed plugins and MCP servers. New tools
start enabled for every bot. A workspace-disabled tool stays unavailable to every bot.

Changing the provider starts a fresh provider session with the same enabled tool set.

## Conversation panel

Use the panel button to collapse or reopen the bot editor. The default shortcut is `Mod+Alt+B`. You
can change **Right Panel: Toggle** in keybinding settings. Narrow screens open the editor as a sheet.

Bot replies support headings, links, tables, task lists, code blocks, math, and Mermaid diagrams.
During longer bot work, the bot posts short status notes after meaningful progress.

## Voice calls

1. Open **Settings > Voice**.
2. Enable voice and choose the connected ChatGPT subscription and voice.
3. Turn on **Voice calls** for the bot.
4. Select the phone button in the bot's chat header.

Akeru uses the microphone and speaker on the current computer. Only one call can run at a time. The
call bar stays visible when you open another bot. Select it to return to the call, or select hang up
to end the call.
