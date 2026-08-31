# Data portability

Open **Settings > General**, then find **Data portability**.

Choose **Export** to download an `akeru.archive` file. The archive includes safe server settings, MCP recipes, bots, groups, mapped project references, thread metadata, conversation text, plans, and approval history.

The archive removes credentials, local paths, project scripts, attachments, image files, Git state, provider sessions, receipts, tool arguments, raw approval payloads, and deleted threads and projects. It replaces image avatars with generated avatars. MCP recipes do not include secrets.

Imported approval rows are history only. An import does not reopen a request or approve an action. Imported MCP servers stay disabled until you reconnect their credentials.

Choose **Import** and select an archive to see a preview. The preview lists additions, changes, conflicts, missing providers, excluded secrets, and records that this environment cannot restore. Review this list before you apply the import.

Akeru Bot can update a project when its existing workspace reference matches the archive. A missing workspace stays unsupported because an archive does not carry an absolute project path. The preview reports this case before import.

Import skips records that need a missing provider. It also skips conflicts when the target has a newer record. If the environment changes after the preview, Akeru Bot stops the import and requires a new preview.

The apply result lists failed records. A partly applied record means at least one write succeeded before another write failed. Review the archive again after any failed or partly applied result.
