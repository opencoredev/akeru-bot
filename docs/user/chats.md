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

## Link a pull request

Right-click a pull-request link and select **Link to chat**. Select **Unlink from chat** from the same
menu to remove it. Linked review state appears with the chat.

## Regenerate a title

Open the chat menu and select **Regenerate title**. The action changes to **Regenerating…** until the
new title is ready. Akeru hides this action when the environment server is too old to support it.

## Environment identification

Development environments can show **Artwork**, a **Version pill**, or **None** at the top of the
sidebar and in the send button. Artwork follows built-in theme colors. Custom themes use the version
pill because Akeru does not control their color palette.
