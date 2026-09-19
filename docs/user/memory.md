# Bot memory

Your bots can carry useful things they learn into future chats. Each bot keeps its own notes about
you, its work, and the groups it participates in. You can inspect, edit, or clear those notes in
Memory from bot or chat settings.

## What a bot remembers

A bot has two kinds of memory. **Chat memory** helps it follow the conversation you are having now.
It keeps recent exchanges and summarizes older conversation as observations. **Bot memory** holds
small, lasting notes that travel with that bot into other chats.

For example, you might tell a bot that you prefer short explanations. It can save that preference
and use it in a later chat. A temporary request such as "make this reply shorter" should stay in the
current conversation instead.

Bot memory has three parts:

| Document    | What it keeps                                              | Limit            |
| ----------- | ---------------------------------------------------------- | ---------------- |
| `USER.md`   | What this bot has learned about you and your preferences   | 1,375 characters |
| `MEMORY.md` | Useful notes, conventions, and lessons for this bot's work | 2,200 characters |
| `GROUP.md`  | This bot's notes for one particular group                  | 2,200 characters |

Each bot owns its notes. If Ava learns your favorite color, Ben does not automatically learn it too.
In a group, Ava and Ben see the conversation but keep separate group notes. Those notes are supplied
only in that group. Removing a bot from the group revokes access to its group notes; adding it back
restores access.

## Learning during conversation

You can say "remember this" explicitly, or let the bot decide which stable facts are worth keeping.
Saving during an ordinary reply depends on the model. A bot may miss a preference the first time.

After ten successful prompts in the same scope, a quiet review becomes due at the next safe turn.
Private chats and each group count separately. This gives the bot another chance to save something
it missed. Failed or cancelled prompts do not count, and restarting Akeru preserves the count.
The review uses a limited selection of recent inputs, so memory is selective rather than a complete
record of everything you say.

Notes have small limits because they are supplied as context when the bot works. When a document is
full, the bot must shorten or replace an entry before adding more. If a file is edited outside
Akeru and exceeds its limit, its contents are withheld from the bot until shortened. The file stays
intact so you can edit it. Bot profile instructions remain
separate and under your control.

## Seeing and changing memory

Open Memory to read or edit a bot's documents. You can remove an entry or clear a document by saving
it empty. You can also inspect and clear the current chat's observations separately. Clearing bot
notes does not erase your chat history, and information still in a conversation may be learned again.

Recent context keeps complete turns, including their tool calls and results, with a normal budget
of 30 turns and roughly 64,000 tokens. Messages not yet covered by observations are retained even
when they exceed that budget.

## Keeping your data

Memory stays on your environment server under Akeru home. Akeru writes files atomically with private
permissions and rejects recognizable credentials and common instruction-override patterns. These
checks are limited; avoid putting secrets in memory or its exports.

Export includes the bot's notes and the active chat's observations. Import shows a preview before
applying changes and restores both. Restore an archive in its original chat. Pending observations
in an archive become active observations when restored. Keep exports private because they can
contain personal details.

When upgrading from saved facts, Akeru migrates approved user, bot, and matching group facts once.
Facts that do not fit, have unsupported scopes, or fail validation are preserved in a migration
archive instead of being silently discarded or shared more broadly.
