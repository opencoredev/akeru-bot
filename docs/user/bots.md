# Configure bots

Open a bot, then use the panel beside the conversation to edit it.

## Skip initial setup

Select **Skip setup** on any setup step, then confirm **Skip setup** in the dialog.
Select **Cancel** to stay in setup. Skipping keeps any connected subscriptions and bots you already
created. Setup will not open again after a restart.

You can connect a subscription in Settings and use **Create** to add a bot later.

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

## Organize the roster

The sidebar lists pinned bots and groups first, followed by the rest under **Bots**. Drag a bot or group to reorder it, pin it, or unpin it. Dragging into **Pinned** pins it at that spot, and dragging a pinned item back into **Bots** unpins it.

Pins only change the roster layout. They do not change group membership or settle chats.

While you drag, the lifted row stays in the roster and moves vertically between available positions. The destination label stays readable and takes the accent color. These transitions follow your reduced-motion preference, and a drop does not replay a second animation.

Pinning, unpinning, and moving an item keeps the sidebar at your current scroll position instead of following the item to its new place in the roster.

On this device the layout is stored in the browser for the connected environment. Refresh keeps it. Other devices keep their own layout until the environment can store roster order.

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
