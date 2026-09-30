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

### Durable facts

Durable facts are the saved facts that outlast a chat, kept separately from chat memory and from a
bot's Markdown notes. Memory lists them in their own section. Pick a scope to see facts saved for
this chat, this bot, or this project. Each fact shows its scope, the chat it came from, the bots it
affects, whether it is approved, waiting for approval, or rejected, when it was created and last
updated, and the value it replaced. Pinned and forgotten facts are marked. Memory loads only the
facts in the scope you pick, without chat transcripts or observations.

Each fact has its own actions:

- **Edit** changes the fact's text. The previous text stays visible as the value it replaced.
- **Pin** keeps a fact marked as important. **Unpin** removes the mark.
- **Make private**, **Move to this bot**, and **Share with project** change who the fact applies
  to. A fact shared with the project may need your approval first; see the settings below.
- **Approve** and **Reject** decide a fact that is waiting for approval. A rejected fact stays in
  the list, and you can still approve it later.
- **Forget** stops the bot from using a fact but keeps it in the list, marked Forgotten, so you can
  still see it. A forgotten fact can only be deleted.
- **Delete** removes a fact for good after you confirm. It can't be restored.

If the same fact changed on another device while you were working, Akeru shows the latest version
with a short message instead of overwriting it. Try the change again on the fresh version. A
connection paired with read-only access can view facts but not change them.

Observation work continues in the background after a reply. A restart picks queued work back up.
If condensing older conversation keeps failing after a few tries, Akeru drops that one piece of
work, notes it in the chat, and keeps newer observations coming; nothing else about the chat is
lost.

Clearing a chat's observations does not remove durable facts, the bot, or its notes. Facts waiting
for approval, rejected facts, and forgotten facts stay out of what the bot uses.

### Approving shared memory

A bot can ask to save a fact for the whole project, its group, or the workspace, so other bots and
later chats know it too. By default, Akeru asks you first. The chat shows a card above the message
box, such as "Save to project memory?", with the bot that asked, the fact, and the bots that would
see it. Facts the bot marks as sensitive, such as personal, health, or financial details, are
labeled "Sensitive, always needs approval" and always wait for you, even when shared project memory
saves automatically.

- **Approve** saves the fact as shown.
- **Edit** lets you change the text first. **Approve edit** saves your version.
- **Reject** discards the request. Nothing is saved.

The same request also appears in the bot inbox in Settings, on desktop, web, and mobile, labeled
Memory approval, with the fact, where it would be saved, and **Approve** and **Reject**. Deciding
in either place closes it in both, and a request stays open across restarts until you decide. The
chat stays usable while a request waits. If several requests are waiting, the card shows them one
at a time, oldest first.

An approved fact appears in Memory under its scope like any other durable fact.

### Memory settings

Settings has a Memory section under Privacy on desktop and web, and under Settings on mobile:

- **Memory** turns durable memory on or off. While it is off, bots do not receive durable facts,
  and no facts can be saved or changed. Existing facts still appear in Memory so you can review
  them. Their actions return when you turn Memory back on.
- **Private bot memory** controls whether each bot keeps private facts that only that bot uses.
  While it is off, the bot's own `MEMORY.md` notes and bot-private facts are not supplied to the
  bot, the memory tool no longer offers the bot's private target, and Memory no longer offers
  **Make private** or **Move to this bot**. Existing bot-private facts still appear in Memory so
  you can review, forget, or delete them.
- **Save shared project memory automatically** decides what happens when a fact is shared with a
  whole project. When it is off, the default, the fact waits for your approval. When it is on, the
  fact is approved right away, unless a bot marks it as sensitive.

Private bot memory and shared project memory only apply while Memory is on, so their switches are
unavailable while it is off.

The mobile app shows the same facts, actions, and settings. Export and import durable facts from
the desktop or web app; mobile does not offer them.

### Exporting and importing durable memory

Choose a scope under Transfer memory, then select Export durable facts. You can export this chat,
this bot, this project, or all memory. The export is a JSON archive with a versioned manifest,
checksums, and the Markdown files it covers. Complete exports include revision history,
forgotten facts, and facts waiting for approval or rejected. Import keeps each fact's approval
state, so a restored fact that was waiting for approval still waits for it. Export notes still exports the bot's notes and the chat's observations on their
own.

Import accepts either kind of archive and always shows a preview first. For durable facts, the
preview lists new, changed, conflicting, and skipped facts. Each conflict shows your fact beside
the archive's version and needs its own choice: keep yours or use the archive. Apply stays
unavailable until every conflict has a choice, so a newer local fact is never replaced silently.
Archives are checked against the current user, bot, group, project, and workspace before any
change is applied.

An all-memory export is export-only. Import a chat, bot, project, or workspace archive so each
authority can be checked safely.
