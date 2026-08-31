# Data portability model coverage

The `akeru.archive` format mirrors data that Akeru owns and can restore without credentials or local paths.

`packages/contracts/src/orchestration.ts` defines the durable read model. It contains projects, bots, groups, MCP servers, and threads. Thread records carry messages, proposed plans, approval activities, avatars, lifecycle state, and workspace or sandbox references. The portability layer restores approval activities as inert `approval.history` rows so an import cannot reopen a provider request.

The same read model has no jobs, routines, or durable memory collection. Provider memory events belong to provider sessions and do not form an Akeru repository. `ServerProvider.skills` in `packages/contracts/src/server.ts` reports discovered provider skills, but Akeru has no persisted skill-assignment model.

`packages/contracts/src/usage.ts` defines a read result, not an Akeru repository. `apps/server/src/usage/UsageService.ts` scans provider-owned Claude and Codex transcript files. It has no write or import operation. The archive preview keeps usage history explicit as unsupported until Akeru owns a durable usage repository.

Restore preflights the full command list before the first write. Each command still has its own SQLite transaction. Apply results therefore report failed and partly applied records instead of claiming the whole archive succeeded.
