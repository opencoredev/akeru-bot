import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  BALANCED_BOT_PERSONALITY_TONE,
  BotId,
  GroupId,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
  type ProjectId,
  ThreadId,
} from "@akeru/contracts";
import { toShellDelegation } from "./orchestration/ShellDelegations.ts";
import { toRoutineReceiptSource } from "./orchestration/routineReceiptSources.ts";

import {
  THREAD_SHELL_REFETCH,
  type ShellSourceEvent,
  type SentThreadShells,
  isUnchangedThreadShell,
} from "./wsSupport.ts";
import type { WsServices } from "./wsServices.ts";

export const createWsOrchestrationStreams = ({
  projectionSnapshotQuery,
  projectionBots,
  projectionGroups,
  channelBindingsForRuntime,
}: Pick<
  WsServices,
  "projectionSnapshotQuery" | "projectionBots" | "projectionGroups" | "channelBindingsForRuntime"
>) => {
  const toShellStreamEvent = (
    source: ShellSourceEvent,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
    if (source.type === THREAD_SHELL_REFETCH) {
      return threadUpsertOrRemove(source.threadId, source.sequence);
    }

    const event = source;

    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
        return projectUpsertOrRemove(event.payload.projectId, event.sequence);
      case "project.deleted":
        return Effect.succeed(
          Option.some({
            kind: "project-removed" as const,
            sequence: event.sequence,
            projectId: event.payload.projectId,
          }),
        );
      case "bot.created":
      case "bot.updated":
      case "bot.archived":
      case "bot.restored":
        return botUpsertOrRemove(event.payload.botId, event.sequence);
      case "bot.deleted":
        return Effect.succeed(
          Option.some({
            kind: "bot-removed" as const,
            sequence: event.sequence,
            botId: event.payload.botId,
          }),
        );
      case "group.created":
      case "group.renamed":
      case "group.member-assigned":
      case "group.member-unassigned":
      case "group.boss-set":
        return groupUpsertOrRemove(event.payload.groupId, event.sequence);
      case "group.deleted":
        return Effect.succeed(
          Option.some({
            kind: "group-removed" as const,
            sequence: event.sequence,
            groupId: event.payload.groupId,
          }),
        );
      case "mcp-server.created":
      case "mcp-server.updated":
      case "mcp-server.enabled":
      case "mcp-server.disabled":
        return Effect.succeed(
          Option.some({
            kind: "mcp-server-upserted" as const,
            sequence: event.sequence,
            mcpServer: event.payload.mcpServer,
          }),
        );
      case "mcp-server.deleted":
        return Effect.succeed(
          Option.some({
            kind: "mcp-server-removed" as const,
            sequence: event.sequence,
            mcpServerId: event.payload.mcpServerId,
          }),
        );
      case "delegation.created":
      case "delegation.updated":
        return Effect.succeed(
          Option.some({
            kind: "delegation-upserted" as const,
            sequence: event.sequence,
            delegation: toShellDelegation(event.payload.delegation),
          }),
        );
      case "routine.drafted":
      case "routine.approved":
      case "routine.enabled":
      case "routine.running":
      case "routine.paused":
      case "routine.blocked":
      case "routine.failed":
      case "routine.completed":
      case "routine.run-canceled":
        return Effect.succeed(
          Option.some({
            kind: "routine-upserted" as const,
            sequence: event.sequence,
            routine: event.payload.routine,
            ...("run" in event.payload ? { run: event.payload.run } : {}),
          }),
        );
      case "routine.deleted":
        return Effect.succeed(
          Option.some({
            kind: "routine-removed" as const,
            sequence: event.sequence,
            routineId: event.payload.routine.id,
            receiptSource: toRoutineReceiptSource(event.payload.routine),
          }),
        );
      case "skill-assignment.assigned":
        return Effect.succeed(
          Option.some({
            kind: "skill-assignment-upserted" as const,
            sequence: event.sequence,
            assignment: event.payload.assignment,
          }),
        );
      case "skill-assignment.unassigned":
        return Effect.succeed(
          Option.some({
            kind: "skill-assignment-removed" as const,
            sequence: event.sequence,
            assignmentId: event.payload.assignmentId,
          }),
        );
      case "thread.deleted":
      case "thread.archived":
        return Effect.succeed(
          Option.some({
            kind: "thread-removed" as const,
            sequence: event.sequence,
            threadId: event.payload.threadId,
          }),
        );
      case "thread.unarchived":
        return threadUpsertOrRemove(event.payload.threadId, event.sequence);
      default:
        if (event.aggregateKind !== "thread") {
          return Effect.succeed(Option.none());
        }

        return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
    }
  };

  // Coalescing makes each projection read represent every event for that
  // aggregate in the current window. Retry a typed persistence failure once
  // so a brief read failure cannot strand the shell at its previous state.
  // If both attempts fail, log and drop the stream item; treating an error as
  // a missing row would incorrectly remove a still-active aggregate.
  const retryShellProjectionRead = <A, E>(
    aggregateKind: "project" | "bot" | "group" | "thread",
    aggregateId: string,
    read: Effect.Effect<A, E>,
  ): Effect.Effect<Option.Option<A>, never, never> =>
    read.pipe(
      Effect.retry({ times: 1 }),
      Effect.map(Option.some),
      Effect.tapError((error) =>
        Effect.logWarning("orchestration shell projection refetch failed", {
          aggregateKind,
          aggregateId,
          error,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );

  const projectUpsertOrRemove = (
    projectId: ProjectId,
    sequence: number,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
    retryShellProjectionRead(
      "project",
      projectId,
      projectionSnapshotQuery.getProjectShellById(projectId),
    ).pipe(
      Effect.map(
        Option.flatMap((project) =>
          Option.match(project, {
            onNone: () =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "project-removed" as const,
                sequence,
                projectId,
              }),
            onSome: (nextProject) =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "project-upserted" as const,
                sequence,
                project: nextProject,
              }),
          }),
        ),
      ),
    );

  const botUpsertOrRemove = (
    botId: BotId,
    sequence: number,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
    retryShellProjectionRead("bot", botId, projectionBots.getById({ botId })).pipe(
      Effect.map(
        Option.flatMap((bot) =>
          Option.match(bot, {
            onNone: () =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "bot-removed",
                sequence,
                botId,
              }),
            onSome: (nextBot) =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "bot-upserted",
                sequence,
                bot: {
                  id: nextBot.botId,
                  name: nextBot.name,
                  title: nextBot.title,
                  label: nextBot.label,
                  description: nextBot.description,
                  disabledMcpServerIds: nextBot.disabledMcpServerIds,
                  avatar: nextBot.avatar,
                  engine: nextBot.engine,
                  sandbox: nextBot.sandbox,
                  runtimeMode: nextBot.runtimeMode,
                  usageCap: nextBot.usageCap,
                  imageProvider: nextBot.imageProvider,
                  personalityTone: nextBot.personalityTone ?? BALANCED_BOT_PERSONALITY_TONE,
                  voiceEnabled: nextBot.voiceEnabled,
                  channelBindings: channelBindingsForRuntime(nextBot.channelBindings ?? []),
                  groupId: nextBot.groupId,
                  archivedAt: nextBot.archivedAt,
                  createdAt: nextBot.createdAt,
                  updatedAt: nextBot.updatedAt,
                },
              }),
          }),
        ),
      ),
    );

  const groupUpsertOrRemove = (
    groupId: GroupId,
    sequence: number,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
    retryShellProjectionRead("group", groupId, projectionGroups.getById({ groupId })).pipe(
      Effect.map(
        Option.flatMap((group) =>
          Option.match(group, {
            onNone: () =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "group-removed",
                sequence,
                groupId,
              }),
            onSome: (nextGroup) =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "group-upserted",
                sequence,
                group: {
                  id: nextGroup.groupId,
                  name: nextGroup.name,
                  bossBotId: nextGroup.bossBotId,
                  members: nextGroup.members,
                  createdAt: nextGroup.createdAt,
                  updatedAt: nextGroup.updatedAt,
                },
              }),
          }),
        ),
      ),
    );

  // Refetch a thread's shell and emit an upsert if it is still active, or a
  // `thread-removed` if the projection has no active row for it. Emitting a
  // removal on a `none` (rather than dropping the event) is what keeps
  // coalescing correct: when a burst collapses a `thread.deleted`/`archived`
  // into a later refetchable event for the same thread, the refetch returns
  // `none` for the now-inactive row and this still tells the sidebar to drop
  // it. A `thread-removed` the client does not have is a harmless no-op. The
  // projection commits in the same transaction before the event publishes,
  // so a `none` reliably means the thread is deleted or archived, not
  // not-yet-persisted.
  const threadUpsertOrRemove = (
    threadId: ThreadId,
    sequence: number,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
    retryShellProjectionRead(
      "thread",
      threadId,
      projectionSnapshotQuery.getThreadShellById(threadId),
    ).pipe(
      Effect.map(
        Option.flatMap((thread) =>
          Option.match(thread, {
            onNone: () =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "thread-removed" as const,
                sequence,
                threadId,
              }),
            onSome: (nextThread) =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "thread-upserted" as const,
                sequence,
                thread: nextThread,
              }),
          }),
        ),
      ),
    );

  // Turn a batch of domain events into shell stream items, coalescing by
  // aggregate first. `toShellStreamEvent` re-reads the *current* projected
  // shell for an aggregate, so within a batch only the latest event per
  // aggregate matters: a burst of streaming `thread.message-sent` deltas for
  // one thread collapses into a single shell refetch, and an unrelated
  // `thread.created` in the same batch is never stuck behind those DB reads.
  //
  // Input events arrive in ascending sequence; we keep the last (highest
  // sequence) event per aggregate, then re-sort ascending before emitting so
  // the client — which applies shell items strictly by increasing sequence
  // and drops any `sequence <= snapshotSequence` — never skips a coalesced
  // item. The refetch runs with bounded concurrency (order-preserving).
  //
  // `sentThreads` holds the last thread shell sent on this subscription, so
  // a refetch that returns an identical shell (for example after a turn
  // diff or checkpoint that changes no sidebar field) is not re-sent unless
  // the client's resume cursor has fallen too far behind.
  const SHELL_REFETCH_CONCURRENCY = 8;

  const coalesceShellEvents = (
    events: ReadonlyArray<ShellSourceEvent>,
    sentThreads: SentThreadShells,
  ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>, never, never> =>
    Effect.gen(function* () {
      if (events.length === 0) {
        return [];
      }

      const latestByAggregate = new Map<string, ShellSourceEvent>();

      for (const event of events) {
        latestByAggregate.set(`${event.aggregateKind}:${event.aggregateId}`, event);
      }

      const survivors = Array.from(latestByAggregate.values()).sort(
        (left, right) => left.sequence - right.sequence,
      );

      const shellEvents = yield* Effect.forEach(survivors, toShellStreamEvent, {
        concurrency: SHELL_REFETCH_CONCURRENCY,
      });

      return shellEvents.flatMap((option) =>
        Option.isSome(option) && !isUnchangedThreadShell(sentThreads, option.value)
          ? [option.value]
          : [],
      );
    });

  // Small time/size window over which to coalesce shell events. The window
  // bounds the worst-case added latency for a brand-new thread to appear in
  // the sidebar (imperceptible), while collapsing high-frequency streaming
  // traffic so it can't serialize the shell stream behind per-event DB reads.
  const SHELL_COALESCE_WINDOW = Duration.millis(50);

  const SHELL_COALESCE_MAX_CHUNK = 512;

  const coalesceShellStream = <E, R>(
    stream: Stream.Stream<OrchestrationEvent, E, R>,
    sentThreads: SentThreadShells,
  ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
    stream.pipe(
      Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
      Stream.mapEffect((events) => coalesceShellEvents(events, sentThreads)),
      Stream.flatMap((items) => Stream.fromIterable(items)),
    );

  // A completion marker is queued alongside raw live events so it cannot
  // overtake an event still waiting in the coalescing window. Split each
  // batch at markers and coalesce only the event segments on either side.
  const coalesceShellLiveInputs = (
    inputs: ReadonlyArray<ShellLiveInput>,
    sentThreads: SentThreadShells,
  ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamItem>, never, never> =>
    Effect.gen(function* () {
      const output: Array<OrchestrationShellStreamItem> = [];
      let pendingEvents: Array<ShellSourceEvent> = [];

      for (const input of inputs) {
        if (input.kind === "event") {
          pendingEvents.push(input.event);
          continue;
        }

        output.push(...(yield* coalesceShellEvents(pendingEvents, sentThreads)));
        pendingEvents = [];
        output.push({ kind: "synchronized" });
      }

      output.push(...(yield* coalesceShellEvents(pendingEvents, sentThreads)));

      return output;
    });

  return {
    toShellStreamEvent,
    retryShellProjectionRead,
    projectUpsertOrRemove,
    botUpsertOrRemove,
    groupUpsertOrRemove,
    threadUpsertOrRemove,
    SHELL_REFETCH_CONCURRENCY,
    coalesceShellEvents,
    SHELL_COALESCE_WINDOW,
    SHELL_COALESCE_MAX_CHUNK,
    coalesceShellStream,
    coalesceShellLiveInputs,
  };
};

export type ShellLiveInput =
  | { readonly kind: "event"; readonly event: ShellSourceEvent }
  | { readonly kind: "synchronized" };
