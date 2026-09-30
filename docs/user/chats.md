# Organize chats

Use a chat's menu to settle, snooze, wake, archive, delete, pin, or unpin it.
Date labels in bot and group chats follow your device's local day and update when the day changes.

## Active and settled chats

Akeru settles a chat only when you select **Settle chat**. Inactivity and pull request state do not
move chats to the settled list.

Settling a pinned chat also removes its pin. **Un-settle chat** returns the chat to the top of the
active list without changing its timestamps.

Use **Snooze** to hide a chat until its wake time. Use **Wake chat** to return it early.

## Pinned order

Pinned chats appear above active bot work across projects and environments. On web and desktop, drag a
pinned chat to reorder it. On mobile, open its menu and select **Move up** or **Move down**.

The environment server stores the order. An older server can still pin a chat but keeps its default
newest-first order until it is updated.

## Group chats

A group is a chat with two or more bots. Open the **+** menu at the top of the roster and select
**New group**. Name the group, pick a **Boss**, and add at least one more bot.

Open a group and use its group sidebar to manage it:

- Change the **Name** and save it.
- Pick a new **Boss**. The previous boss stays in the group as a regular member.
- Add a bot with **Add bot**. When every bot is already in the group, the sidebar says so.
- Remove a bot with its remove button. A group always keeps at least two bots, and you cannot
  remove the boss until another bot is the boss. The sidebar explains which rule applies.
- **Delete group** asks for confirmation. Its bots stay in your roster.

The boss answers every message by default. Type `@` and a bot's name, such as `@Mori`, to send that
message to that bot instead. It answers with its own provider and model. If a message mentions
several bots, the last mention wins. If two bots in the group share a name, Akeru cannot tell them
apart, so it holds the message and asks you to rename one of them. Mentions of people, such as
`@Leo`, stay plain text and the boss answers. On mobile, a reply shows the bot's avatar and name
whenever a different bot starts speaking.

Groups hold bots only. You cannot add people to a group yet.

## Work sent to other bots

A bot can hand part of a request to another bot. The bot does not wait for that work. It replies
first, and a work card in the chat shows the other bot, the task, and its state: queued, running,
blocked, completed, failed, or canceled. On mobile the same card appears inline in the chat and
stays visible when that turn's work log is collapsed. Its **Let it finish**, **Cancel**, and **Try again**
buttons work the same as on web and desktop.

On web and desktop, each card sits right after the exchange that started the work, and it stays
there when you reload or come back later. Work started in three different replies shows up as
three cards at three points in the chat. The card also shows how long the work has taken and the
tokens it used. A card labelled **Scheduled** came from a routine, and **Retried** means it
replaces an earlier attempt. In a group chat the card names both bots, such as "Akeru asked
Mori", because any bot in the group can hand off work.

Open **Details** on a card to see the expected result and the access the other bot was given,
including its tools and MCP servers. **View work** opens a read-only view of the other bot's chat
for that work. **Open chat** takes you to that bot's own chat, where you can keep talking to it.
Handed-off work only appears as cards. It never becomes the bot's chat in the sidebar and does not
show up in chat search.

While work is still running, the chat shows **Waiting on delegated work**. When the work finishes,
the card shows the result or what went wrong, and one of these lines:

- **Result waiting for the next reply** means your bot has not seen the result yet. Send another
  message and the bot uses the result in that reply. If you send nothing, the result stays on the
  card.
- **Result delivered to {name}** means your bot has received the result, with {name} naming your
  bot that received it. It does not receive it again.

A bot runs at most three pieces of work at a time from one chat. Asking the same bot twice starts
two separate pieces of work, each with its own card.

In a group chat, a bot can hand work only to bots in that group. The other bot does the work in
its own chat. When it finishes, it posts the result in the group as **Finished work for {name}**.

Bots on standard OpenCode cannot hand off work or take it from other bots. OpenCode Go bots can.
The bot's Tools sheet says so, the `@` menu in a group chat marks the bot with **Cannot take
handed-off work**, and on mobile the chat settings show the same note under Options. A bot that
tries to hand them work is told to pick a bot on another provider.

If the bot that did the work leaves the group before it finishes, its result stays on its card but
is not posted in the group.

Work that has a deadline stops at the deadline. Work without one stops after 4 hours if the other
bot has not reported back. Either way the card shows it as failed because it timed out.

On web, desktop, and mobile, a card's buttons change with the state of the work:

- **Let it finish** keeps running work going even if you stop the reply that started it. A bot can
  also mark its own work this way. Once work is kept, the button goes away.
- **Cancel** stops queued, running, or blocked work.
- **Try again** appears on failed or canceled work. It starts new work for the same bot with the
  same task and gets its own card; the original card keeps its result. Each card can be retried
  once: after you try again, the original card drops the button, and further retries start from
  the newer card. A retry is refused while three pieces of work from the chat are still running.

A retry sends the task and expected result again, but not the extra background your bot added when
it first handed off the work. If that background matters, ask your bot to send the work again
instead.

If an action fails, a message explains why and the card stays as it was.

## Tables, checklists, and other rich replies

Bot replies render richer Markdown directly in the chat. There is no separate dashboard.

- **Tables** keep their header row and scroll sideways when they are wider than the chat.
- **Checklists** show each task as done or open. You cannot tick them. A list with two or more
  tasks also shows a summary such as "2 of 3 done".
- **Diffs** in a `diff` or `patch` code block appear as a change card. Added and removed lines are
  tinted, and the card header shows the file name and how many lines changed.
- **File references** appear as code cards titled with the file path, or as file chips inside a
  sentence.
- **Links** open in your browser.
- **Settings chips** open a section of Settings for the same environment as the chat. Hover a chip
  to see which section it opens, for example **Open Settings > Voice**. A chip that points
  somewhere Akeru does not recognize stays plain text and never opens outside the app.

While a reply is still streaming, Akeru waits for a table's header to finish before it shows the
table, and it waits for a partial code fence, list marker, or heading underline to complete. The
reply looks the same after it finishes and after you reload the chat.

On mobile, tables, checklists, file references, and links look the same as on desktop. Diffs appear
as a plain code block without the tinted lines or counts, and checklists do not show the progress
summary. Settings chips open the matching mobile screen, or the main Settings screen when mobile
has no matching screen.

## When a bot goes quiet

A provider that stops sending output does not stall the chat silently. See
[When a bot goes quiet](silence-watchdog.md) for the notice, the inbox item,
and what you can do.

## Link a pull request

Right-click a pull-request link and select **Link to chat**. Select **Unlink from chat** from the same
menu to remove it. Linked review state appears with the chat.

## Regenerate a title

Open the chat menu and select **Regenerate title**. The action changes to **Regenerating…** until the
new title is ready. Akeru hides this action when the environment server is too old to support it.

## Read a reply aloud

Completed bot replies include **Read aloud**. That speaks the stored reply on this device. It does
not start a live call or generate another answer. See [Voice and spoken replies](voice.md).

## Environment identification

Development environments can show **Artwork**, a **Version pill**, or **None** at the top of the
sidebar and in the send button. Artwork follows built-in theme colors. Custom themes use the version
pill because Akeru does not control their color palette.
