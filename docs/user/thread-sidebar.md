# Organize threads

Use a thread's menu to settle, snooze, wake, archive, delete, pin, or unpin it.

## Active and settled threads

Akeru settles inactive threads after three days by default. An open pull request blocks inactivity
settlement. Closed pull requests settle their threads, and merged pull requests settle them when
**Auto-settle merged threads** is on.

Settling a pinned thread also removes its pin. **Un-settle thread** returns the thread to the top of
the active list without changing its timestamps.

Use **Snooze** to hide a thread until its wake time. Use **Wake thread** to return it early.

## Pinned order

Pinned threads appear above active work across projects and environments. On web and desktop, drag a
pinned thread to reorder it. On mobile, open its menu and select **Move up** or **Move down**.

The environment server stores the order. An older server can still pin a thread but keeps its default
newest-first order until it is updated.

## Link a pull request

Right-click a pull-request link and select **Link to thread**. Select **Unlink from thread** from the
same menu to remove it. Linked review state appears with the thread and can trigger automatic
settlement.

## Regenerate a title

Open the thread menu and select **Regenerate title**. The action changes to **Regenerating…** until
the new title is ready. Akeru hides this action when the environment server is too old to support it.

## Environment identification

Development environments can show **Artwork**, a **Version pill**, or **None** at the top of the
sidebar and in the send button. Artwork follows built-in theme colors. Custom themes use the version
pill because Akeru does not control their color palette.
