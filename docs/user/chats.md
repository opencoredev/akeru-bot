# A bot's conversations

Each bot keeps a history of conversations. Use a conversation's menu to settle, snooze, wake,
archive, delete, pin, or unpin it.

## Active and settled conversations

Akeru settles a conversation only when you select **Settle chat**. Inactivity and pull request
state do not move conversations to the settled list.

Settling a pinned conversation also removes its pin. **Un-settle chat** returns the conversation
to the top of the active list without changing its timestamps.

Use **Snooze** to hide a conversation until its wake time. Use **Wake chat** to return it early.

## Pinned order

Pinned conversations appear above active bot work across projects and environments. On web and
desktop, drag a pinned conversation to reorder it. On mobile, open its menu and select **Move up**
or **Move down**.

The environment server stores the order. An older server can still pin a conversation but keeps
its default newest-first order until it is updated.

## Link a pull request

Right-click a pull-request link and select **Link to chat**. Select **Unlink from chat** from the
same menu to remove it. Linked review state appears with the conversation.

## Regenerate a title

Open the conversation menu and select **Regenerate title**. The action changes to **Regenerating…**
until the new title is ready. Akeru hides this action when the environment server is too old to
support it.

## Read a reply aloud

Completed bot replies include **Read aloud**. That speaks the stored reply on this device. It does
not start a live call or generate another answer. See [Voice and spoken replies](voice.md).

## Environment identification

Development environments can show **Artwork**, a **Version pill**, or **None** at the top of the
sidebar and in the send button. Artwork follows built-in theme colors. Custom themes use the version
pill because Akeru does not control their color palette.
