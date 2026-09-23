# Configure bots

Open a bot, then use the panel beside the conversation to edit it.

## Initial setup

Setup connects a subscription, then asks one question: what you want help with. Answer it in your
own words, in a sentence or two. Select one of the examples to fill in an answer you can rewrite.

From that answer your bot proposes where it will start, as a short numbered plan, along with the one
detail it will come back to you for later. Select **Edit** to reword your answer and get a new plan,
or **Looks right** to move on to naming your bot.

The last step drafts your first message from that plan. Edit it if you like, then send it. Once your
bot has started on it, the chat opens with your message already in it, and setup fades away.
If the bot is archived before the chat opens, Akeru clears the pending opening and tells you to
create or select another bot.

Setup does not ask where the work should go, how often it should run, or which actions it may
take on its own. Your bot raises those when it reaches the point of needing them.

## Skip initial setup

Select **Skip setup** on any setup step, then confirm **Skip setup** in the dialog.
Select **Cancel** to stay in setup. Skipping keeps any connected subscriptions and bots you already
created. Setup will not open again after a restart.

You can connect a subscription in Settings and use **Create** to add a bot later. When the roster is
empty, the main view shows **Create bot**.

## Profile

You can change the bot's avatar, name, label, description, model, voice access, and enabled tools.
Select **Save** to apply the changes. The model button in the composer shows which model answers the
next message. Select it to change the bot's model without leaving the chat. If the provider stops
offering the bot's model, the button keeps showing it and marks it unavailable until you choose
another one.

In a group chat, you can still message a member with a configured provider even when the boss
cannot reply. Mention that member in your message to direct the turn to them.
You can send a follow-up while an earlier group message is still being accepted. Both messages stay
in the same chat.
Archived members cannot receive new group messages.

Shaped avatars are a flat colored body with a face. The eyes are cut out of the body, so they take
the color of whatever sits behind the avatar. Very light and very dark custom colors draw their eyes
on instead. Bots saved with an older preset color show the matching color from the current palette.

Avatars rest on a still frame. A working bot sways, glances down at its work, and now and then turns
its face around its body. Point at a bot and its eyes widen and follow the pointer. Now and then one
resting bot on screen blinks or glances around. With reduced motion turned on, avatars stay still.

Set **Token hard stop** to interrupt the current step when it reaches the selected limit. A settled
reply shows its engine, step tokens, and estimated USD cost when the provider reports enough usage
data.

Akeru stores bot profiles on the connected environment. Every client connected to that environment
sees the same profile.

## Workspaces and browsers

**Separate** is the default. Each bot gets its own workspace identity and browser profile. **Shared**
lets bots share files and browser cookies.

When a bot shares its browser, the panel shows a small capture of its screen. Select **Open** to
expand it, and select the collapse button or press Esc to shrink it again.

Bots can use Local, E2B, Daytona, Vercel Sandbox, or Upstash Box. Connect remote services under
**Settings > Sandbox**. A bot-specific sandbox overrides the environment default.
If a managed browser stops unexpectedly, Akeru records the failure in the bot inbox so you can
retry the browser task after it is available again. Each affected workspace keeps its own notice
until its browser works again.

Local bots use **Auto review** by default. Safe actions continue without a prompt. Actions that send,
pay, delete, change production, use secrets, or have unclear intent still ask. Select **Settings >
General > Local execution** to ask before each local change or grant full access. Bots that run in a
cloud sandbox do not show the local computer prompt.

## Run a routine

Open **Routines** in the bot panel. Add a routine, procedure, schedule, timezone, required skills,
and connectors. Select **Test** to test the routine, then approve the procedure before you enable its
schedule.

Each routine card shows its schedule, status, and latest result. Select a card to see when it runs,
its latest run, its instructions, and its workspace. You can run, pause, resume, edit, or delete the
routine there, then select the back button to return to the list. A procedure change needs approval
again. A draft routine shows **Draft** until you approve its procedure.

The bot's chat notes when a routine is created, starts a run, and finishes, fails, or is canceled.
Deleting a routine removes it from the Routines panel while keeping those earlier notes in the chat.
The older notes remain readable without opening the Routines panel.
The chat loads recent routine notes first. Select **Load older routine notes** above the conversation
to bring earlier runs into view.

If a required connector, provider, bot, or workspace is unavailable, Akeru pauses the routine and
adds one item to the bot inbox. Fix the dependency, then resume the routine. Restoring an archived
bot does not resume its routines.

## Tools

Open **Tools** in the bot editor to enable or disable installed plugins and MCP servers. New tools
start enabled for every bot. A workspace-disabled tool stays unavailable to every bot.

Changing the provider starts a fresh provider session with the same enabled tool set.

## Organize the roster

The sidebar shows pinned bots and groups as launcher cards at the top, followed by the rest as detailed rows under **Bots**. Drag a bot or group to reorder it, pin it, or unpin it. Dragging into **Pinned** pins it at that spot, and dragging a pinned item back into **Bots** unpins it.

To archive a bot, open its menu and select **Archive bot**. Archived bots leave the roster and stop
taking messages, but their chats are kept. A message sent from another device that still shows the
bot is refused with a note that the bot is archived. Open **Archived** at the bottom of the roster and select
**Restore** to bring one back.

Pins only change the roster layout. They do not change group membership or settle chats.

While you drag, the lifted row stays in the roster and moves vertically between available positions. The destination label stays readable and takes the accent color. These transitions follow your reduced-motion preference, and a drop does not replay a second animation.

Pinning, unpinning, and moving an item keeps the sidebar at your current scroll position instead of following the item to its new place in the roster.

On this device the layout is stored in the browser for the connected environment. Refresh keeps it. Other devices keep their own layout until the environment can store roster order.

## Conversation panel

Use the panel button to collapse or reopen the bot editor. The default shortcut is `Mod+Alt+B`. You
can change **Right Panel: Toggle** in keybinding settings. Narrow screens open the editor as a sheet.

Bot replies support headings, links, tables, task lists, code blocks, math, and Mermaid diagrams.
While a bot works, a small pixel meter sits under the latest message with the bot's current step and
the elapsed time. The meter sweeps once when the bot starts or moves to a new step, then holds still.
With reduced motion turned on, it skips the sweep. The timer counts whole seconds either way.
During longer bot work, the bot posts short status notes after meaningful progress.

When a bot hands work to another bot or group, the chat shows a card for each handoff. Cards for
work that is still running always stay. For finished, failed, or canceled work, the chat keeps the
20 most recent cards, and a long result shows its first 2,000 characters. Open the delegated chat to
read the full result.

When a request fails, the chat shows a short card that says what went wrong and what to do next. A
provider that is turned off or signed out gets an **Open providers** button. When the cause is
unknown, select **Send feedback** to report it with its details. Expand **Technical details** to see
the underlying error, or select **Resume** when an interrupted request can continue. On mobile, the resume card
shows the same summary.

## Voice calls

1. Open **Settings > Voice**.
2. Enable voice and choose the connected ChatGPT subscription and voice.
3. Turn on **Voice calls** for the bot.
4. Select the phone button in the bot's chat header.

Akeru uses the microphone and speaker on the current computer. Only one call can run at a time. The
call bar stays visible when you open another bot. Select it to return to the call, or select hang up
to end the call.

## Image generation

Open the bot's settings and choose a provider under **Workspace > Image generation**, or keep
**Use global default**. This does not change the bot's chat model. See
[Image generation](image-generation.md).
