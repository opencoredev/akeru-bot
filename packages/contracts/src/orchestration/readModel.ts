import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RepositoryIdentity, ThreadEnvMode } from "../environment.ts";
import {
  AuthSessionId,
  BotId,
  GroupId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { McpServer, McpServerId } from "../mcpServer.ts";
import { AkeruDelegationRecord } from "../akeruDelegation.ts";
import {
  Routine,
  RoutineId,
  RoutineRun,
  RoutineReceiptSource,
  RoutineSkillAssignment,
  SkillAssignmentId,
} from "../routines.ts";
import { DelegationIdSchema } from "./identities.ts";
import {
  ModelSelection,
  RuntimeMode,
  ProviderInteractionMode,
  DEFAULT_PROVIDER_INTERACTION_MODE,
} from "./modelSelection.ts";
import {
  ProjectScript,
  ProjectFaviconPath,
  OrchestrationProject,
  OrchestrationBot,
  OrchestrationGroup,
} from "./roster.ts";
import {
  OrchestrationSession,
  OrchestrationLatestTurn,
  ThreadTitleRegeneration,
  ThreadLinkedPullRequest,
  OrchestrationThread,
} from "./thread.ts";

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  bots: Schema.Array(OrchestrationBot).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  groups: Schema.Array(OrchestrationGroup).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  delegations: Schema.Array(Schema.suspend(() => AkeruDelegationRecord)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  mcpServers: Schema.optional(Schema.Array(McpServer)),
  routines: Schema.optional(Schema.Array(Routine)),
  routineRuns: Schema.optional(Schema.Array(RoutineRun)),
  skillAssignments: Schema.optional(Schema.Array(RoutineSkillAssignment)),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});

export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Optional on the wire so cached snapshots from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  botId: Schema.optional(Schema.NullOr(BotId)),
  groupId: Schema.optional(Schema.NullOr(GroupId)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  parentDelegationId: Schema.optional(Schema.NullOr(DelegationIdSchema)),
  respondingBotId: Schema.optional(Schema.NullOr(BotId)),
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROVIDER_INTERACTION_MODE)),
  ),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  settledAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // See OrchestrationThread.unsettledAt: last re-entry into the active list.
  unsettledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  pinOrderKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleRegeneration: Schema.optional(Schema.NullOr(ThreadTitleRegeneration)),
  session: Schema.NullOr(OrchestrationSession),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  hasActionableProposedPlan: Schema.Boolean,
  /**
   * Native background work alive after the turn settles: "working" while
   * subagents/workflows run, "monitoring" when watch loops are the only
   * live work. Optional so old servers/clients interop; absent = none.
   */
  backgroundLiveness: Schema.optional(Schema.NullOr(Schema.Literals(["working", "monitoring"]))),
  /**
   * Current plan step while a turn runs, for the Working indicators
   * (sidebar row, in-chat working line). Cleared when the turn settles —
   * never persists as stale UI. Optional so old servers/clients interop.
   */
  planProgress: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        step: TrimmedNonEmptyString,
        completedSteps: NonNegativeInt,
        totalSteps: NonNegativeInt,
      }),
    ),
  ),
});

export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  currentPersonId: Schema.optional(AuthSessionId),
  currentPersonDisplayName: Schema.optional(TrimmedNonEmptyString),
  environmentHostPersonId: Schema.optional(AuthSessionId),
  environmentHostDisplayName: Schema.optional(TrimmedNonEmptyString),
  projects: Schema.Array(OrchestrationProjectShell),
  bots: Schema.Array(OrchestrationBot).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  groups: Schema.Array(OrchestrationGroup).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  delegations: Schema.Array(Schema.suspend(() => AkeruDelegationRecord)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  mcpServers: Schema.optional(Schema.Array(McpServer)),
  routines: Schema.optional(Schema.Array(Routine)),
  routineReceiptSources: Schema.optional(Schema.Array(RoutineReceiptSource)),
  routineRuns: Schema.optional(Schema.Array(RoutineRun)),
  skillAssignments: Schema.optional(Schema.Array(RoutineSkillAssignment)),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
});

export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("bot-upserted"),
    sequence: NonNegativeInt,
    bot: OrchestrationBot,
  }),
  Schema.Struct({
    kind: Schema.Literal("bot-removed"),
    sequence: NonNegativeInt,
    botId: BotId,
  }),
  Schema.Struct({
    kind: Schema.Literal("group-upserted"),
    sequence: NonNegativeInt,
    group: OrchestrationGroup,
  }),
  Schema.Struct({
    kind: Schema.Literal("group-removed"),
    sequence: NonNegativeInt,
    groupId: GroupId,
  }),
  Schema.Struct({
    kind: Schema.Literal("mcp-server-upserted"),
    sequence: NonNegativeInt,
    mcpServer: McpServer,
  }),
  Schema.Struct({
    kind: Schema.Literal("mcp-server-removed"),
    sequence: NonNegativeInt,
    mcpServerId: McpServerId,
  }),
  Schema.Struct({
    kind: Schema.Literal("delegation-upserted"),
    sequence: NonNegativeInt,
    delegation: Schema.suspend(() => AkeruDelegationRecord),
  }),
  Schema.Struct({
    kind: Schema.Literal("routine-upserted"),
    sequence: NonNegativeInt,
    routine: Routine,
    run: Schema.optional(RoutineRun),
  }),
  Schema.Struct({
    kind: Schema.Literal("routine-removed"),
    sequence: NonNegativeInt,
    routineId: RoutineId,
    receiptSource: Schema.optional(RoutineReceiptSource),
  }),
  Schema.Struct({
    kind: Schema.Literal("skill-assignment-upserted"),
    sequence: NonNegativeInt,
    assignment: RoutineSkillAssignment,
  }),
  Schema.Struct({
    kind: Schema.Literal("skill-assignment-removed"),
    sequence: NonNegativeInt,
    assignmentId: SkillAssignmentId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);

export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("synchronized"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);

export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({
  /**
   * When provided, the server skips the initial full shell snapshot and instead
   * replays shell events after this sequence before streaming live events.
   * Clients that already hold a cached (or HTTP-loaded) shell snapshot pass its
   * sequence here so the subscription resumes without re-sending the entire
   * projects/threads list (overlapping events are deduped by sequence on the
   * client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
});

export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * When provided, the server skips the initial snapshot frame and instead
   * replays events after this sequence before streaming live events. Clients
   * that load the snapshot over HTTP pass the snapshot's sequence here so the
   * live subscription resumes without a gap (overlapping events are deduped by
   * sequence on the client).
   */
  afterSequence: Schema.optionalKey(NonNegativeInt),
  /**
   * Requests an explicit marker after the subscription has emitted its initial
   * snapshot or catch-up replay and before it begins emitting live events.
   */
  requestCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * When provided, the fallback snapshot frame (sent when `afterSequence` is
   * missing or the catch-up gap is too large) is windowed to the last
   * `turnLimit` user-anchored turns and carries `page` metadata. Absent means
   * the fallback snapshot is the full thread, preserving pre-pagination client
   * behavior. Live events are unaffected either way.
   */
  turnLimit: Schema.optionalKey(PositiveInt),
});

export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

/**
 * Bounds a thread detail read to a window of recent turns. `turnLimit` counts
 * turns with a user pending message (subagent/fan-out turns between them ride
 * along), so the window always contains the last N user prompts. `beforeCursor`
 * requests the disjoint page of older turns strictly before a previously
 * returned cursor. Requests without a window get the full thread; pagination is
 * strictly opt-in so older clients keep today's behavior on both HTTP and the
 * WebSocket fallback snapshot.
 */
export const OrchestrationThreadDetailWindow = Schema.Struct({
  turnLimit: Schema.optionalKey(PositiveInt),
  beforeCursor: Schema.optionalKey(TrimmedNonEmptyString),
});

export type OrchestrationThreadDetailWindow = typeof OrchestrationThreadDetailWindow.Type;

/**
 * Page metadata for a windowed thread detail read. `beforeCursor` is opaque and
 * exclusive: passing it back returns the adjacent disjoint slice of older
 * turns. `null` means the thread is fully loaded below this page. The
 * `snapshotSequence` mirrors the top-level snapshot sequence so history pages
 * can be sequence-checked against live state before merging.
 */
export const OrchestrationThreadDetailPage = Schema.Struct({
  beforeCursor: Schema.NullOr(TrimmedNonEmptyString),
  hasMore: Schema.Boolean,
  snapshotSequence: NonNegativeInt,
  /**
   * Highest event sequence applied to THIS thread at page read time. The
   * global `snapshotSequence` advances with every thread's events, so a
   * client cannot wait for it via its per-thread subscription; this
   * thread-scoped watermark is reachable. A client merging an older page
   * must first have applied live events up to it — otherwise a streaming
   * turn outside the loaded window could have deltas replayed on top of
   * page content that already includes them, duplicating text.
   */
  threadSequence: Schema.optionalKey(NonNegativeInt),
});

export type OrchestrationThreadDetailPage = typeof OrchestrationThreadDetailPage.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
  // Present only on windowed responses. Absent on full snapshots (and from
  // pre-pagination servers), which clients treat as fully loaded.
  page: Schema.optional(OrchestrationThreadDetailPage),
});

export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;
