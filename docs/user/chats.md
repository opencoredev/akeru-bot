# Organize chats

Use a chat's menu to settle, snooze, wake, archive, delete, pin, or unpin it.

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
`@Leo`, stay plain text and the boss answers.

Groups hold bots only. You cannot add people to a group yet.

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
