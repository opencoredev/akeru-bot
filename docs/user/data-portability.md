# Move Akeru data

Open **Settings > General** and find **Data portability**.

## Export

Select **Export** to download an `akeru.archive` file. The archive can contain safe server settings,
MCP recipes, bots, groups, mapped project references, chat metadata, conversation text, proposed
plans, and approval history.

The export excludes secrets, provider credentials, durable memory, routines, skill assignments,
usage history, files, Git repositories, terminals, attachments, and checkpoints.

## Import

1. Select **Import** and choose an archive.
2. Review the bots, groups, projects, chats, settings, and skipped items in **Restore preview**.
3. Map project paths to directories on the destination environment.
4. Select **Restore**.

The archive limit is 20 MiB. Akeru validates the complete archive before it writes any restored data.
Unsupported or unsafe entries appear in the preview and remain skipped.

Desktop can use its native project-folder picker. Browser and mobile clients cannot browse the
server's filesystem through that picker, so map paths from a desktop client when needed.

Keep the archive private. It can contain conversation text, project paths, bot instructions, and
approval history even though it excludes credentials.
