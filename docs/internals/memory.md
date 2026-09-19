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
5. thread observations;
6. up to 30 complete recent turns within an approximate 64,000-token budget;
7. the current user message.

The file snapshot is read immediately before Mastra admission. Codex, Claude, Grok, Kimi,
and OpenCode Go use this unified path, including instance-specific model transports. Standard
OpenCode is the compatibility runtime and receives memory through its native per-prompt system
field. Memory refresh does not require restarting a chat.

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

The memory archive schema is version 3. It binds file paths, scope IDs, file checksums, the
observational snapshot checksum, and a manifest checksum. Preview validates all files and produces a
hash of the archive plus current destination state. Apply recomputes it and refuses stale previews.
Import holds all affected file locks and captures original files before applying changes. A failed
write or observation restore rolls back the attempted changes before releasing the locks. File
locks renew their lease while held. Observation restores and clears share the per-thread background
observation queue.
Observation records are cleared and reinserted through Mastra's storage adapter when restoration is
required. Imports must target the archive's original thread. Flattened buffered observations are
promoted into active observations on restore so Mastra's chunk-based storage retains their text.
