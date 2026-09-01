# Data portability model coverage

The `akeru.archive` format mirrors data that Akeru owns and can restore without credentials or local paths.

`packages/contracts/src/orchestration.ts` defines the durable read model. It contains projects, bots, groups, MCP servers, routines, routine runs, skill assignments, and threads. Thread records carry messages, proposed plans, approval activities, avatars, lifecycle state, and workspace or sandbox references. The portability layer restores approval activities as inert `approval.history` rows so an import cannot reopen a provider request.

The main archive does not export or restore routines, routine runs, or skill assignments yet. Durable memory has a separate SQLite repository and a version 2 memory archive with preview and apply support.

`packages/contracts/src/usage.ts` defines a read result, not an Akeru repository. `apps/server/src/usage/UsageService.ts` scans provider-owned Claude and Codex transcript files. It has no write or import operation, so the main portability archive does not include usage history.

Restore preflights the full command list before the first write. Each command still has its own SQLite transaction. Apply results therefore report failed and partly applied records instead of claiming the whole archive succeeded.

Archives omit absolute workspace paths. Preview accepts an explicit project-to-folder map for projects that do not match an existing project ID, repository identity, or workspace name. The server requires existing absolute directories, rejects duplicate or occupied destinations, binds the map to the preview checksum, and restores each mapped project through `project.create` before its threads. Apply skips unmapped projects and their threads while it restores independent records.
