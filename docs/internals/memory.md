# Memory architecture

Akeru has two complementary memory layers:

1. `BotMemoryStore` owns small Markdown documents scoped to a named bot. `USER.md` and `MEMORY.md`
   are private to the bot. `groups/<group-id>/GROUP.md` is also bot-owned; there is no group-wide
   writable file.
2. Mastra observational memory condenses older messages for one thread. It does not write the
   Markdown documents.

Bot instructions are configuration, not memory. The bot sees them first but cannot change them with
the memory tool.

## Context assembly

Mastra providers use this logical order on every turn:

1. bot instructions;
2. `USER.md`;
3. `MEMORY.md`;
4. the responding bot's active `GROUP.md`;
5. the `<entity-memory>` packet of current entity facts;
6. thread observations;
7. up to 30 complete recent turns within an approximate 64,000-token budget;
8. the current user message.

The file snapshot is read immediately before Mastra admission. Codex, Claude, Grok, Kimi,
and OpenCode Go use this unified path, including instance-specific model transports. Standard
OpenCode is the compatibility runtime and receives memory through its native per-prompt system
field. Memory refresh does not require restarting a chat.

Entity memory packets are built by `ProviderMemoryPacket` from authorized current revisions. The
builder applies the same ordering and fact, character, and token bounds for every provider, so
Mastra providers and the OpenCode compatibility bridge receive equivalent memory input. Both append
the packet to the persistent memory context after the Markdown snapshot and before thread
observations. A
tombstone is excluded on the next packet or recall read. Tombstoning also removes derived-copy
rows; the Mastra invalidation call clears that thread's observational memory before a later turn
can rebuild it.

## Automatic curation

`AkeruMemoryTurnHarness` is the single provider-neutral memory lifecycle. Every provider enters the
same interface to reserve a review, assemble its scoped snapshot, wrap the memory handler, record
foreground success, verify exactly one successful review call, and release or retry the claim.
Provider adapters only decide how their native transport carries the supplied context and terminal
event; they do not implement memory cadence or settlement policy.

The foreground bot instructions and memory tool description tell every provider to save stable user
preferences, personal facts, desires, and lasting behavioral expectations without waiting for an
explicit "remember" request. The same guidance excludes one-off work and temporary task state.

Each bot has independent durable cadences for its private scope and every exact group scope. The
private file is `memory/bots/<bot-id>/.memory-review.json`; group cadence files sit beside their
`GROUP.md`. A terminally successful provider turn atomically increments that scope and appends its
candidate. There is no lock, reservation, or polling lane held across a foreground model turn.
Failed, aborted, interrupted, and cancelled turns do not count.

After 10 successful prompts beyond the reviewed cursor, the completed batch is due. A separate short
claim selects that bounded batch under the file lock without blocking foreground admission. Claims
use a renewable 60-second lease. Active controller fibers renew every 20 seconds and cancel renewal
in their terminal, error, and finalizer paths. A crashed process stops renewing, and another live
process can recover only after expiry. Claims cover exact candidate IDs and the recorded count cursor;
concurrent successes start the next batch and are neither cleared nor disclosed by the older review.
Settlement is idempotent across duplicate terminal events and store instances. Candidates are
truncated to 1,000 characters, and each scope keeps the newest 10 candidates whose complete JSON
array, including brackets and separators, fits the 8,000-character budget. The generated review
prompt is capped at 12,000 characters.

Cadence files are scheduling metadata, not memory. A malformed or invalid file is renamed under the
same private bot directory with a `.memory-review.corrupt-...json` name and `0600` permissions. Akeru
then writes a valid conservative state that makes the next successful prompt carry a review.

Codex, Claude, Grok, Kimi For Coding, and OpenCode Go receive the due bundle through the
unified Mastra turn context. Standard OpenCode receives it through its native per-prompt system
field. A due batch is reviewed during the next admitted turn. There is no separate Claude maintenance
session or Grok ACP review resource in the active provider path.
Private turns never receive a group target, and a group review never grants access to another bot's
file. For queued group responders, memory handlers change only when that responder's turn is
admitted; the active turn retains its original bot and group access for its full lifetime. Every
automatic review must make exactly one successful memory call. A no-op review reads the user target
with an empty operations array so the server can verify completion; zero or multiple successful calls
leave the claimed inputs due for retry. Reviews emit no user-visible message and add no second reply.

Recent selection groups provider messages at user-turn boundaries. It never takes part of a turn,
and unobserved messages are mandatory even when they exceed the ordinary count or token budget. The
canonical Akeru projection remains the user-facing conversation record. Provider-local history is
used at the model boundary because it preserves native tool-call/result structures that the
projection intentionally renders as activities.

## File boundary

`BotMemoryStore` is the only module that resolves writable memory paths. IDs are restricted to safe
path components. Existing path components and targets may not be symlinks. Writes take a
cross-process lock, reread under that lock, validate the complete operation batch, fsync a private
temporary file, and rename it over the destination. Documents use `0600`; directories use `0700`.

The delimiter between independently addressable entries is `\n\n§\n\n`. Exact duplicate additions
are no-ops. Replacement and removal require one unique substring match. The final rendered document,
not each intermediate operation, is checked against its character budget.

Tool and editor writes reject common instruction-override or prompt-exfiltration text, invisible
Unicode controls, private keys, and recognizable credential prefixes. Hand-edited files are scanned
when read for a prompt; unsafe entries are replaced by a visible blocked marker without modifying the
source file. Oversized documents are withheld with a bounded marker. The final sanitized content
is also checked against the limit, because blocked-entry notices can expand the original text.
Editor writes include the displayed snapshot's bot ID and original content. The server checks both
under the file lock and rejects changes made since the editor loaded.

## Legacy migration

The old entity-memory tables remain in the database for one rollback release but have no UI, tool,
candidate, packet, search, or mutation RPC path. At the first session for a bot, the migration reads
approved active revisions and writes a completion marker under that bot's memory directory. User and
bot-user facts map to `USER.md`, matching bot facts map to `MEMORY.md`, and matching active-group facts
map to that bot's `GROUP.md`. Other scopes, mismatched entities, rejected unsafe text, and overflow go
to `memory/migration-archive/` and are never injected.

Private and group markers are independent. This lets a bot migrate a newly encountered group later
without re-running its private migration.

## Archive format

The T17 memory facts view reads current durable facts through `memory.facts.list`.
Its input is `{ threadId, target }` and its result is `{ facts }`, containing only
fact metadata and text. The RPC requires read scope; writes continue to use the
durable repository authorization path.

`memory.facts.mutate` serves the durable-fact edits the view needs: it accepts
`{ threadId, mutation }` where the mutation is one of `fact.edit` (`{ fact }`),
`fact.pin` (`{ pinned }`), `fact.scope` (`{ scope }`), `fact.decide`
(`{ decision: "approve" | "reject" }`), `fact.forget`, or `fact.delete`. Every
mutation carries `memoryId` (the root) and `expectedRevision` for optimistic
concurrency. Edits, pins, scope moves, decisions, and forgets are recorded as
new revisions on the same root (a tombstone for forget); delete removes the
root and its history outright. The result is `{ kind: "revision", revision }`
or `{ kind: "deleted", memoryId }`. Each write goes through the M1-T11
`authorizeRevision` ownership checks, re-resolves the target scope's partition
against the same thread context for scope changes, and deletes the root's
`akeru_memory_derived_copies` rows so packet and summary readers rebuild from
the new chain. The RPC requires the operate scope.

Server settings carry the durable memory switches as `settings.memory`:
`enabled` ("Memory on", default true), `privateBotMemory` ("Private bot memory
on", default true), and `sharedProjectMemory` ("Shared project memory",
`"ask"` or `"auto"`, default `"ask"`). With `"ask"`, a fact moved onto a
shared project partition lands `pending` and must be approved through
`fact.decide` before it joins current recall. The settings hold no embedding
or model configuration; durable memory is not a model feature.

`enabled === false` rejects every `memory.facts.mutate` write and
`memory.document.replace` write at the WS boundary, and the agent controller
withholds the bot's whole memory prompt snapshot and memory tool. That
includes `fact.forget` and `fact.delete`, and the web fact list hides every
action while Memory is off. Listing and export remain available so the user
can still inspect stored facts; cleanup needs Memory turned back on.

`privateBotMemory === false` narrows that gate to the bot-private scope. The
memory tool loses its `memory` (bot-private `MEMORY.md`) target, the
`MEMORY.md` section is omitted from the prompt snapshot supplied on every
turn (including legacy-adapter sessions), the `<entity-memory>` packet drops
current facts in the `bot` and `bot-user` partitions on both the Mastra and
legacy paths, `memory.document.replace` rejects
writes to the `memory` target, and `memory.facts.mutate` rejects
`fact.scope` moves onto `private`/`bot` partitions. Reads are unaffected:
`memory.facts.list`, archive export, and `memory.documents.inspect` still
return existing bot-private facts and notes so the user can forget or delete
them.

The memory archive schema is version 3. It binds file paths, scope IDs, file checksums, the
observational snapshot checksum, and a manifest checksum. Preview validates all files and produces a
hash of the archive plus current destination state. Apply recomputes it and refuses stale previews.
Import holds all affected file locks and captures original files before applying changes. A failed
write or observation restore rolls back the attempted changes before releasing the locks. A failed
observation restore fails with `AkeruObservationRestoreError`, whose `cause` is the original
failure; `rolledBack` says whether the original records came back, and `rollbackCause` carries the
rollback failure when both fail. File locks renew their lease while held. Observation restores and
clears share the per-thread observation lock.
Observation records are cleared and reinserted through Mastra's storage adapter when restoration is
required. Imports must target the archive's original thread. Flattened buffered observations are
promoted into active observations on restore so Mastra's chunk-based storage retains their text.

## Durable entity archive format

The durable ledger export is a version 2 JSON envelope whose `files` are UTF-8 Markdown
records. Each record is at `durable/<root-id>/<revision>.md`; its `akeru-memory`
frontmatter contains the root and revision IDs, partition scope and ID, entity ownership,
provenance, approval and deletion state, timestamps, and revision links. The `sha256` value
on every file and revision covers its canonical JSON or Markdown content. `manifestSha256`
covers the schema version, target, completeness flag, timestamps, and the file, revision, and
conversation checksums. Complete exports include every revision in a chain, including a
terminal tombstone, so another tool can inspect history without Akeru.

Import first validates checksums, chain links, approval state, tombstone position, and that
every partition and entity belongs to the importing user's authorized thread. Preview reports
`new`, `changed`, `conflicting`, and `skipped` roots. A conflicting root must receive an
explicit `keep-local` or `use-archive` decision in the apply request; absent decisions are
rejected. `use-archive` replaces that root's local history with the validated archive chain,
while `keep-local` leaves it untouched.

Durable archives use the `memory.archive.*` RPCs. `memory.archive.export` accepts a thread,
bot, project, or all scope and returns the V2 archive. Preview returns per-root `new`, `changed`,
`conflicting`, or `skipped` outcomes. Apply requires explicit `keep-local` or `use-archive`
resolutions for every conflict. The older `memory.documents.*` RPCs remain available for V3
Markdown document archives and compatibility imports.
All-scope archives are export-only: import must target one authority domain so ownership can be
validated without granting a combined archive access across unrelated users or workspaces.

Clients read durable facts through `memory.facts.list` for one thread, bot, or
project scope. The server collapses each root to its current revision, including
pending, rejected, and forgotten facts, and fills `supersededFact` from the previous
revision's text; chat snapshots never cross the wire on this path. Client action
rules (`durableFactActions`, `durableFactMutation`) live in
`packages/client-runtime/src/durableMemory.ts` and always send the fact's
`expectedRevision`, so a stale edit fails with a revision conflict instead of
overwriting a newer one. Mutations go through
`memory.facts.mutate`, which also serves `candidate.decide` for shared memory
approvals (below). `conversation.clear` exists in contracts but is not served
over WebSocket.
Import review lives in the same module: `resolveImportConflicts` has no default decision and
returns resolutions only after every conflicting root has one.

## Observational memory durability

Observation work is a rebuildable cache, but queue admission is durable. Each completed turn first
records a pending observation in `mastra-observational-memory.sqlite.queue.sqlite`, a dedicated
store beside the Mastra memory DB. The queue store is owned by `AkeruMastraHarness`, which opens it
directly and never sees the Effect migration runner, so it versions itself with `PRAGMA
user_version` instead of an environment-store migration. A background drain claims one row at a time
with a single conditional `UPDATE` (a lease expires after five minutes so a crashed drain cannot
hold a row forever), then runs Mastra observation without holding up the reply. A failed attempt
increments `attempts`, releases the claim, and pushes `next_attempt_at` out by a short backoff, so a
stuck observation never blocks later rows; the third failure removes the row and emits a
user-visible `memory.observation.dropped` activity. Startup drains rows left by a previous process,
so a restart does not silently lose queued work, and `busy_timeout` plus enqueue error handling keep
queue contention off the reply path. Observer and Reflector calls use the same usage ledger hooks
for every provider path, including legacy external turns.

`makeAkeruMastraHarness` is a scoped Effect. It acquires the Mastra memory store and the queue store
and releases both when its scope closes; the agent controller layer owns that scope. Observation,
restore, clear, and drain work runs in fibers the harness scope owns, and each thread's memory work
takes that thread's one-permit semaphore, so work on one thread runs in order while other threads
run alongside. Closing the scope first stops admission, so later calls fail with
`AkeruObservationQueueClosedError`, a completed turn writes no queue row, and the drain stops
claiming rows. It then gives admitted work `observationCloseGrace` (five seconds by default) to
finish, interrupts anything still running or waiting for a permit, and hands claimed rows back to the
queue with their attempt count unchanged before it closes the stores. Rows left in the queue are
drained by the next harness at startup.
Observation records are cleared and reinserted through Mastra's storage adapter when restoration is
required. Imports must target the archive's original thread. Flattened buffered observations are
promoted into active observations on restore so Mastra's chunk-based storage retains their text.

## Shared memory approvals

Bots save shared facts through the same `memory` tool: an optional `share`
field (`{ fact, scope: "project" | "group" | "workspace", sensitive? }`) is
handled in `BotMemoryToolHandlers.ts` and forwarded to the agent controller's
`shareFact`. Because the handler set is shared, the Mastra controller (Codex, Claude,
Grok, Kimi, OpenCode Go) and the MCP bridge for the legacy adapter (standard
OpenCode) take the same path. `shareFact` checks the bot's scope grant and calls
`MemoryApprovals.propose` (`apps/server/src/memory/MemoryApprovals.ts`) with
the `sharedProjectMemory` mode.

In `"auto"` mode a non-sensitive fact is written directly with
`EntityMemoryRepository.insertScopedFact`. Otherwise `propose` stores a
pending row in `akeru_memory_candidates`, appends a
`memory.approval.requested` thread activity whose payload is an
`AkeruMemoryApprovalRequest`, and opens an `approval-request` bot inbox item
keyed `memory-approval:<candidateId>` that carries the same request as
`memoryApproval`. The tool result reports `pending` so the bot does not retry.

`candidate.decide` on `memory.facts.mutate` calls `MemoryApprovals.decide`.
Decisions are serialized, must come from the candidate's source thread, and
write an `akeru_memory_candidate_receipts` row. Approve (optionally with an
edited `fact`) inserts an approved revision; reject writes nothing. The
decision then appends `memory.approval.resolved` and resolves the inbox item.
A repeat decision for the same candidate returns the first receipt, so the
chat card and inbox cannot double-apply.

Clients derive open requests with `pendingMemoryApprovals` in
`packages/client-runtime/src/durableMemory.ts`: a requested activity with no
resolved activity for the same `candidateId`. Because this reads persisted
activities, pending cards survive reload. The web chat renders
`MemoryApprovalPrompt` in the composer's pending-action slot; web Settings and
the mobile bot inbox decide items with `memoryApprovalMutation` against the
request's `sourceThreadId`.
