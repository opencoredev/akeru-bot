# Data portability

Open **Settings > General**, then find **Data portability**.

Choose **Export** to download an `akeru.archive` file. The archive includes safe server settings, MCP recipes, bots, groups, project references, and thread metadata.

The archive excludes credentials, environment variables, local paths, project scripts, attachments, image files, Git state, provider sessions, receipts, event identifiers, conversation messages, plans, approval history, snooze timers, and settled state. MCP recipes do not include secrets.

Choose **Import** and select an archive to see a preview. The preview lists additions, changes, conflicts, missing providers, excluded secrets, and records that this environment cannot restore. Review this list before you apply the import.

Akeru Bot can restore safe settings, MCP recipes, bots, groups, and thread metadata when the target project exists. It cannot restore projects. Imported MCP servers stay disabled until you reconnect their secrets.

Import skips records that need a missing provider. It also skips conflicts when the target has a newer record. If the environment changes after the preview, Akeru Bot stops the import and requires a new preview.
