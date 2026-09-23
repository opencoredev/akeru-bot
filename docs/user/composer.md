# Message composer

Messages can contain up to 120,000 characters. Akeru keeps an oversized draft in the composer and
shows how many characters you must remove. Shorten the draft or send it as several messages.

On mobile, unsent drafts and queued messages stay on the device. If Akeru cannot read a draft store,
it leaves the saved work in place instead of treating it as empty. Readable queued messages still
send after reconnect. An unreadable queued-message file stays on the device until it can be read. A
send that fails because the connection dropped stays queued and retries when the environment is
reachable again.

## Attach images

On servers with direct uploads, an image starts uploading when you add it. Akeru enables **Send**
after every upload finishes. Retry or remove a failed upload.

Web and desktop convert HEIC and HEIF photos to JPEG when you drag or paste them into the composer.

## Commands and skills

Type `/` to open the command menu. Type `$` to search for a skill and add its token to the message.

The list shows the skills of the provider the chat is using. Each result shows the skill's own
emoji when it has one, or a glyph for where the skill came from. The source label reads App, Repo,
Project, Personal, System, or Provider. A selected skill appears as a tinted chip in the composer
with the same emoji, and sends as `$name`.

The slash menu includes skills by default. Turn off **Show skills in slash menu** under
**Settings > General** to keep it command-only. Slash-menu skill results use the
`/skill:Skill Name` label and insert the same `$name` token. Akeru hides duplicate native provider
commands when the same skill is already available.

On Claude, picking a skill from the `$` menu is sent as a trailing `/name` command so Claude Code
runs that skill. Codex still reads `$name` natively. The message you see in the chat stays `$name`.

## Mention the browser or another chat

Type `@` to open the mention menu. Use the arrow keys to move through it, `Enter` or `Tab` to pick,
and `Escape` to close it. On mobile, tap a row.

Pick **Browser** to ask the bot to use the preview browser for this message. Akeru tells the bot to
work in the same preview browser you see instead of starting its own. **Browser** only appears when
**Bot browser access** is on under **Settings > Browser**.

Pick a chat to give the bot recent context from it. Chats from the current project come first,
then the most recently updated. Type `@chat:` to list only chats. Archived chats and the
background chats that bots create for delegated work never appear. Only chats on the same
environment are listed.

The menu also lists files from the project folder after the browser, bots, and chats, so typing
`@src/comp` still finds `src/components`. When what you type looks like a path, a chat is only
offered if its title matches.

When two bots share a name, the menu lists both and shows each one's role, or a short id if
the roles match too. Picking one mentions that exact bot, and the reply comes from it.

Each mention shows as a chip with the browser, the chat title, or the bot's name. Remove a chip
to drop that mention from the message. A chat the app cannot see, such as one that was deleted,
shows as **Unknown chat**, and a bot that was deleted shows as **Unknown bot**.

The bot receives a short excerpt, not the whole chat:

- the last 3 turns of each mentioned chat
- up to 4,000 characters per chat, and up to 1,200 characters per message
- at most 3 chats per message; further mentions stay as plain references

The excerpt is read when the bot starts the turn, so it reflects the chat at that moment.

## Start bot work in the background

From a new chat on desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux. Akeru
starts the chat, opens another new chat, and shows an **Open** action for the bot work in progress.

The background chat keeps the selected workspace mode and base branch. If **New worktree** is
selected, each background chat creates a separate worktree.
