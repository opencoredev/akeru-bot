# Message composer

Messages can contain up to 120,000 characters. Akeru keeps an oversized draft in the composer and
shows how many characters you must remove. Shorten the draft or send it as several messages.

## Attach images

On servers with direct uploads, an image starts uploading when you add it. Akeru enables **Send**
after every upload finishes. Retry or remove a failed upload.

Web and desktop convert HEIC and HEIF photos to JPEG when you drag or paste them into the composer.

## Commands and skills

Type `/` to open the command menu. Type `$` to search for a skill and add its token to the message.

Skill results identify their source as App, Repo, Project, Personal, System, or Provider. A selected
skill appears as a badge in the composer.

The slash menu includes skills by default. Turn off **Show skills in slash menu** under
**Settings > General** to keep it command-only. Slash-menu skill results use the
`/skill:Skill Name` label and insert the same `$name` token. Akeru hides duplicate native provider
commands when the same skill is already available.

## Start bot work in the background

From a new chat on desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux. Akeru
starts the chat, opens another new chat, and shows an **Open** action for the bot work in progress.

The background chat keeps the selected workspace mode and base branch. If **New worktree** is
selected, each background chat creates a separate worktree.
