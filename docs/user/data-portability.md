# Data portability

Open **Settings > General**, then find **Data portability**.

Choose **Export** to download an `akeru.archive` file. The archive includes safe server settings, MCP recipes, bots, groups, mapped project references, thread metadata, conversation text, plans, and approval history.

The archive removes credentials, local paths, project scripts, attachments, image files, Git state, provider sessions, receipts, tool arguments, raw approval payloads, and deleted threads and projects. It replaces image avatars with generated avatars. MCP recipes do not include secrets.

Imported approval rows are history only. An import does not reopen a request or approve an action. Imported MCP servers stay disabled until you reconnect their credentials.

Choose **Import** and select an archive to see a restore preview. The preview lists additions, changes, conflicts, missing providers, and data that stays on the source device. Review this list before you restore the archive.

Akeru Bot updates a project when its existing workspace reference matches the archive. For each missing workspace, choose an existing local folder in the preview. Akeru Bot links the restored project to that folder without copying its files, then restores its threads. Import skips unmapped projects and their threads without blocking independent records.

Import skips records that need a missing provider. It also skips conflicts when the target has a newer record. If the environment changes after the preview, Akeru Bot stops the import and requires a new preview.

The restore result lists failed records. A partly restored record means at least one write succeeded before another write failed. Review the archive again after any failed or partly restored result.
