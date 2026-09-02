import {
  AKERU_DELEGATION_MAX_CONCURRENCY,
  AKERU_DELEGATION_MAX_DEPTH,
  type AkeruDelegationRecord,
  type AkeruDelegationState,
  BotId,
  DEFAULT_LOCAL_EXECUTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  GroupId,
  isGroupBotMember,
  MessageId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeUtil from "node:util";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import type { OrchestrationDispatchActor } from "./Services/OrchestrationEngine.ts";
import {
  listThreadsByProjectId,
  requireActiveGroupMember,
  requireProjectWorkspaceRootAbsent,
  requireBot,
  requireBotAbsent,
  requireBotArchived,
  requireBotNotArchived,
  requireDelegation,
  requireDelegationAbsent,
  requireGroup,
  requireGroupAbsent,
  requireGroupThreadCreateAuthorized,
  requireGroupOwnedThreadMutationAuthorized,
  requireMcpServer,
  requireMcpServerAbsent,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";
import { nextScheduledFor } from "../routines/schedule.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function userInputAnswerText(answers: Record<string, unknown>): string | null {
  const values = Object.values(answers).flatMap((answer) => {
    if (typeof answer === "string") return [answer];
    if (Array.isArray(answer)) {
      return answer.filter((value): value is string => typeof value === "string");
    }
    return [];
  });
  const text = values
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  return text.length > 0 ? text : null;
}

// Session adoption takes seconds; a user message still unadopted after this
// window is a failed/stale start, not pending work. Mirrors the client's
// QUEUED_TURN_START_GRACE_MS in client-runtime threadSettled.ts.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;
const TERMINAL_DELEGATION_STATES = new Set<AkeruDelegationState>([
  "failed",
  "canceled",
  "completed",
]);
const DELEGATION_STATE_TRANSITIONS: Record<
  Exclude<AkeruDelegationState, "failed" | "canceled" | "completed">,
  ReadonlySet<AkeruDelegationState>
> = {
  queued: new Set(["running", "failed"]),
  running: new Set(["blocked", "failed", "completed"]),
  blocked: new Set(["running", "failed"]),
};

function delegationStateError(delegation: AkeruDelegationRecord): string | null {
  switch (delegation.state) {
    case "queued":
      return delegation.startedAt === null &&
        delegation.completedAt === null &&
        delegation.result === null &&
        delegation.failure === null
        ? null
        : "Queued delegations cannot have start, completion, result, or failure data.";
    case "running":
    case "blocked":
      return delegation.childThreadId !== null &&
        delegation.startedAt !== null &&
        delegation.completedAt === null &&
        delegation.result === null &&
        delegation.failure === null
        ? null
        : `${delegation.state} delegations require childThreadId and startedAt without completion data.`;
    case "failed":
      return delegation.completedAt !== null &&
        delegation.result === null &&
        delegation.failure !== null
        ? null
        : "Failed delegations require completedAt and failure without a result.";
    case "canceled":
      return delegation.completedAt !== null &&
        delegation.result === null &&
        delegation.failure === null
        ? null
        : "Canceled delegations require completedAt without result or failure data.";
    case "completed":
      return delegation.childThreadId !== null &&
        delegation.startedAt !== null &&
        delegation.completedAt !== null &&
        delegation.result !== null &&
        delegation.result.childThreadId === delegation.childThreadId &&
        delegation.result.childTurnId === delegation.childTurnId &&
        delegation.failure === null
        ? null
        : "Completed delegations require start, completion, and result data without a failure.";
  }
}

function hasSameDelegationOwnership(
  current: AkeruDelegationRecord,
  next: AkeruDelegationRecord,
): boolean {
  return NodeUtil.isDeepStrictEqual(current, {
    ...next,
    childThreadId: current.childThreadId,
    childTurnId: current.childTurnId,
    state: current.state,
    result: current.result,
    failure: current.failure,
    updatedAt: current.updatedAt,
    startedAt: current.startedAt,
    completedAt: current.completedAt,
  });
}

/**
 * Blocked-on-you work derived from the thread's retained activities: an
 * approval or user-input request with no later resolution for the same
 * requestId. The server-side twin of the shell's hasPendingApprovals /
 * hasPendingUserInput flags, which the decider read model does not carry.
 * The clearing rules MUST match ProjectionPipeline's pending accounting —
 * resolved activities always clear, respond.failed clears only when the
 * failure detail marks the request stale/unknown — or settle would be
 * rejected on threads whose shell flags read as clear.
 */
function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request") ||
    detail.includes("stale pending user-input request") ||
    detail.includes("unknown pending user-input request") ||
    detail.includes("unknown pending user input request") ||
    detail.includes("unknown pending codex user input request")
  );
}

// Scans the read model's activities, which the projector caps at the most
// recent 500. That bound is safe here: an OPEN approval/user-input request
// blocks its turn, so the thread cannot accumulate hundreds of later
// activities while one is outstanding — a request that has scrolled out of
// the window is one whose turn kept running, i.e. it was resolved or went
// stale. (The projection pipeline's pendingApprovalCount reads the same
// capped stream and stays consistent with this view.)
function hasOpenBlockingRequest(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): boolean {
  const openRequestIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      openRequestIds.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      openRequestIds.delete(requestId);
    } else if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStaleRequestFailureDetail(payload)
    ) {
      openRequestIds.delete(requestId);
    }
  }
  return openRequestIds.size > 0;
}

/**
 * A queued turn start — a user message no turn has picked up yet — is work
 * in flight even though session is still null (turn.start emits
 * message-sent + turn-start-requested; the session arrives later). Detection
 * mirrors the client's hasQueuedTurnStart: the newest user message is
 * strictly newer than every latestTurn timestamp (adoption stamps the new
 * turn's requestedAt with the message time, clearing this), and only within
 * the adoption grace window — historical threads whose last user message
 * postdates their turn timestamps (older-server data, mid-turn messages)
 * must not be blocked forever. A failed session start (status "error")
 * clears the block immediately.
 *
 * The age check is bounded on BOTH sides: message timestamps are
 * client-supplied, so a client clock ahead of the server yields a negative
 * age. Without the lower bound that negative age satisfies `<= grace` for
 * as long as the skew lasts, extending the block far past the intended two
 * minutes.
 */
function threadHasQueuedTurnStart(
  thread: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>;
    readonly latestTurn: {
      readonly requestedAt: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    } | null;
    readonly session: { readonly status: string } | null;
  },
  occurredAt: string,
): boolean {
  const latestUserMessageAtMs = thread.messages.reduce(
    (latest, message) =>
      message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest,
    Number.NEGATIVE_INFINITY,
  );
  const latestTurnAtMs =
    thread.latestTurn === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          ...[
            thread.latestTurn.requestedAt,
            thread.latestTurn.startedAt,
            thread.latestTurn.completedAt,
          ].map((candidate) =>
            candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
          ),
        );
  const queuedAgeMs = Date.parse(occurredAt) - latestUserMessageAtMs;
  return (
    thread.session?.status !== "error" &&
    Number.isFinite(latestUserMessageAtMs) &&
    latestUserMessageAtMs > latestTurnAtMs &&
    Math.abs(queuedAgeMs) <= QUEUED_TURN_START_GRACE_MS
  );
}

function activeGroupBotIds(
  readModel: OrchestrationReadModel,
  group: OrchestrationReadModel["groups"][number],
): Set<BotId> {
  const activeBotIds = new Set(
    readModel.bots.filter((bot) => bot.archivedAt === null).map((bot) => bot.id),
  );
  return new Set(
    group.members
      .filter(isGroupBotMember)
      .map((member) => member.botId)
      .filter((botId) => activeBotIds.has(botId)),
  );
}

function botGroupUpdatedEvent(input: {
  readonly botId: BotId;
  readonly groupId: GroupId | null;
  readonly occurredAt: string;
  readonly commandId: OrchestrationCommand["commandId"];
}): Effect.Effect<PlannedOrchestrationEvent, PlatformError.PlatformError, Crypto.Crypto> {
  return withEventBase({
    aggregateKind: "bot",
    aggregateId: input.botId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
  }).pipe(
    Effect.map((base) => ({
      ...base,
      type: "bot.updated" as const,
      payload: {
        botId: input.botId,
        groupId: input.groupId,
        updatedAt: input.occurredAt,
      },
    })),
  );
}

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

export const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
  actor,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
  readonly actor?: OrchestrationDispatchActor;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
      ...(actor !== undefined ? { actor } : {}),
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
  actor,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  readonly actor?: OrchestrationDispatchActor;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
    case "thread.delete":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.meta.update":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.voice-transcript.append":
    case "thread.turn.interrupt":
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.checkpoint.revert":
    case "thread.session.stop": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      yield* requireGroupOwnedThreadMutationAuthorized({ readModel, thread, command, actor });
      break;
    }
  }

  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          faviconPath: null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workspaceRoot !== undefined) {
        yield* requireProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.defaultThreadEnvMode !== undefined
            ? { defaultThreadEnvMode: command.defaultThreadEnvMode }
            : {}),
          ...(command.faviconPath !== undefined ? { faviconPath: command.faviconPath } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          ...(actor !== undefined ? { actor } : {}),
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "bot.create": {
      yield* requireBotAbsent({ readModel, command, botId: command.botId });
      const group =
        command.groupId === null
          ? null
          : yield* requireGroup({ readModel, command, groupId: command.groupId });
      const botCreatedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "bot",
          aggregateId: command.botId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "bot.created",
        payload: {
          botId: command.botId,
          name: command.name,
          title: command.title,
          label: command.label ?? null,
          description: command.description ?? null,
          disabledMcpServerIds: command.disabledMcpServerIds ?? [],
          avatar: command.avatar,
          engine: command.engine,
          sandbox: command.sandbox,
          runtimeMode:
            command.runtimeMode ??
            (command.sandbox === null || command.sandbox === "local"
              ? DEFAULT_LOCAL_EXECUTION_MODE
              : DEFAULT_RUNTIME_MODE),
          usageCap: command.usageCap,
          voiceEnabled: command.voiceEnabled ?? false,
          channelBindings: [],
          groupId: command.groupId,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      if (
        group === null ||
        group.members.some((member) => isGroupBotMember(member) && member.botId === command.botId)
      ) {
        return botCreatedEvent;
      }
      return [
        {
          ...(yield* withEventBase({
            aggregateKind: "group",
            aggregateId: group.id,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "group.member-assigned",
          payload: {
            groupId: group.id,
            member: { kind: "bot", botId: command.botId, role: "specialist" },
            updatedAt: command.createdAt,
          },
        },
        botCreatedEvent,
      ];
    }

    case "bot.update": {
      const bot = yield* requireBot({ readModel, command, botId: command.botId });
      const targetGroup =
        command.groupId == null
          ? null
          : yield* requireGroup({ readModel, command, groupId: command.groupId });
      if (command.groupId !== undefined && command.groupId !== null) {
        yield* requireBotNotArchived({ readModel, command, botId: command.botId });
      }
      const sourceGroup =
        command.groupId !== undefined && bot.groupId !== null && bot.groupId !== command.groupId
          ? readModel.groups.find((group) => group.id === bot.groupId)
          : undefined;
      const sourceMembership = sourceGroup?.members
        .filter(isGroupBotMember)
        .find((member) => member.botId === bot.id);
      if (sourceGroup && (sourceMembership?.role === "boss" || sourceGroup.bossBotId === bot.id)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${bot.id}' is the boss of group '${sourceGroup.id}'. Replace it with 'group.boss.set' before changing its group.`,
          }),
        );
      }
      if (sourceGroup && sourceMembership) {
        const remainingBotIds = activeGroupBotIds(readModel, sourceGroup);
        remainingBotIds.delete(bot.id);
        if (remainingBotIds.size < 2) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Group '${sourceGroup.id}' requires at least two active bots.`,
            }),
          );
        }
      }

      const occurredAt = yield* nowIso;
      const events: PlannedOrchestrationEvent[] = [];
      if (sourceGroup && sourceMembership) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "group",
            aggregateId: sourceGroup.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "group.member-unassigned",
          payload: { groupId: sourceGroup.id, botId: bot.id, updatedAt: occurredAt },
        });
      }
      if (
        command.groupId !== undefined &&
        targetGroup !== null &&
        targetGroup.id !== bot.groupId &&
        !targetGroup.members.some((member) => isGroupBotMember(member) && member.botId === bot.id)
      ) {
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "group",
            aggregateId: targetGroup.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "group.member-assigned",
          payload: {
            groupId: targetGroup.id,
            member: { kind: "bot", botId: bot.id, role: "specialist" },
            updatedAt: occurredAt,
          },
        });
      }
      events.push({
        ...(yield* withEventBase({
          aggregateKind: "bot",
          aggregateId: command.botId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "bot.updated",
        payload: {
          botId: command.botId,
          ...(command.name !== undefined ? { name: command.name } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.label !== undefined ? { label: command.label } : {}),
          ...(command.description !== undefined ? { description: command.description } : {}),
          ...(command.disabledMcpServerIds !== undefined
            ? { disabledMcpServerIds: command.disabledMcpServerIds }
            : {}),
          ...(command.avatar !== undefined ? { avatar: command.avatar } : {}),
          ...(command.engine !== undefined ? { engine: command.engine } : {}),
          ...(command.sandbox !== undefined ? { sandbox: command.sandbox } : {}),
          ...(command.runtimeMode !== undefined ? { runtimeMode: command.runtimeMode } : {}),
          ...(command.usageCap !== undefined ? { usageCap: command.usageCap } : {}),
          ...(command.voiceEnabled !== undefined ? { voiceEnabled: command.voiceEnabled } : {}),
          ...(command.channelBindings !== undefined
            ? { channelBindings: command.channelBindings }
            : {}),
          ...(command.groupId !== undefined ? { groupId: command.groupId } : {}),
          updatedAt: occurredAt,
        },
      });
      return events;
    }

    case "bot.archive": {
      yield* requireBotNotArchived({ readModel, command, botId: command.botId });
      const bossGroup = readModel.groups.find((group) => group.bossBotId === command.botId);
      if (bossGroup) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${command.botId}' is the boss of group '${bossGroup.id}'. Set a new boss before archiving it.`,
          }),
        );
      }
      const undersizedGroup = readModel.groups.find((group) => {
        if (
          !group.members.some(
            (member) => isGroupBotMember(member) && member.botId === command.botId,
          )
        ) {
          return false;
        }
        const remainingBotIds = activeGroupBotIds(readModel, group);
        remainingBotIds.delete(command.botId);
        return remainingBotIds.size < 2;
      });
      if (undersizedGroup) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Group '${undersizedGroup.id}' requires at least two active bots.`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      const archivedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "bot",
          aggregateId: command.botId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "bot.archived" as const,
        payload: {
          botId: command.botId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
      const pausedEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      for (const routine of readModel.routines ?? []) {
        if (
          routine.botId !== command.botId ||
          !routine.enabled ||
          routine.lifecycle === "deleted"
        ) {
          continue;
        }
        pausedEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "routine",
            aggregateId: routine.id,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "routine.paused",
          payload: {
            routine: {
              ...routine,
              enabled: false,
              lifecycle: "paused",
              nextRunAt: null,
              updatedAt: occurredAt,
            },
          },
        });
      }
      return [...pausedEvents, archivedEvent];
    }

    case "bot.restore": {
      yield* requireBotArchived({ readModel, command, botId: command.botId });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "bot",
          aggregateId: command.botId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "bot.restored",
        payload: {
          botId: command.botId,
          updatedAt: occurredAt,
        },
      };
    }

    case "group.create": {
      yield* requireGroupAbsent({ readModel, command, groupId: command.groupId });
      if (command.bossBotId === undefined) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "A group requires a boss bot.",
          }),
        );
      }

      const memberBotIds = [
        command.bossBotId,
        ...new Set((command.specialistBotIds ?? []).filter((botId) => botId !== command.bossBotId)),
      ];
      yield* Effect.forEach(memberBotIds, (botId) =>
        requireBotNotArchived({ readModel, command, botId }),
      );
      if (memberBotIds.length < 2) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Group '${command.groupId}' requires at least two active bots.`,
          }),
        );
      }

      const groupCreatedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: command.groupId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "group.created",
        payload: {
          groupId: command.groupId,
          name: command.name,
          bossBotId: command.bossBotId,
          members: [
            ...memberBotIds.map((botId) => ({
              kind: "bot" as const,
              botId,
              role: botId === command.bossBotId ? ("boss" as const) : ("specialist" as const),
            })),
            ...(command.creator === undefined ? [] : [command.creator]),
          ],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      return groupCreatedEvent;
    }

    case "group.rename": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: command.groupId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.renamed",
        payload: {
          groupId: command.groupId,
          name: command.name,
          updatedAt: occurredAt,
        },
      };
    }

    case "group.delete": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const occurredAt = yield* nowIso;
      const deletedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: command.groupId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.deleted",
        payload: {
          groupId: command.groupId,
          deletedAt: occurredAt,
        },
      };
      const botUpdatedEvents = yield* Effect.forEach(
        group.members
          .filter(isGroupBotMember)
          .filter(
            (member) =>
              readModel.bots.find((bot) => bot.id === member.botId)?.groupId === command.groupId,
          ),
        (member) =>
          botGroupUpdatedEvent({
            botId: member.botId,
            groupId: null,
            occurredAt,
            commandId: command.commandId,
          }),
      );
      const threadUpdatedEvents = yield* Effect.forEach(
        readModel.threads.filter((thread) => thread.groupId === command.groupId),
        Effect.fn(function* (thread) {
          return {
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: thread.id,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "thread.ownership-updated" as const,
            payload: {
              threadId: thread.id,
              botId: null,
              groupId: null,
              updatedAt: occurredAt,
            },
          };
        }),
      );
      return [...botUpdatedEvents, ...threadUpdatedEvents, deletedEvent];
    }

    case "group.member.assign": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const bot = yield* requireBotNotArchived({ readModel, command, botId: command.botId });
      if (command.role === "boss" && group.bossBotId !== null && group.bossBotId !== bot.id) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Group '${group.id}' already has boss bot '${group.bossBotId}'. Use 'group.boss.set' to replace it.`,
          }),
        );
      }
      if (command.role === "specialist" && group.bossBotId === bot.id) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${bot.id}' is the boss of group '${group.id}' and cannot be assigned as a specialist.`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      const assignedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: group.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.member-assigned",
        payload: {
          groupId: group.id,
          member: { kind: "bot", botId: bot.id, role: command.role },
          updatedAt: occurredAt,
        },
      };
      return assignedEvent;
    }

    case "group.member.unassign": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const member = group.members
        .filter(isGroupBotMember)
        .find((entry) => entry.botId === command.botId);
      if (!member) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${command.botId}' is not a member of group '${group.id}'.`,
          }),
        );
      }
      if (member.role === "boss" || group.bossBotId === command.botId) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${command.botId}' is the last boss of group '${group.id}'. Set a new boss and unassign the previous boss with one 'group.boss.set' command.`,
          }),
        );
      }
      const remainingBotIds = activeGroupBotIds(readModel, group);
      remainingBotIds.delete(command.botId);
      if (remainingBotIds.size < 2) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Group '${group.id}' requires at least two active bots.`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      const unassignedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: group.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.member-unassigned",
        payload: {
          groupId: group.id,
          botId: command.botId,
          updatedAt: occurredAt,
        },
      };
      return unassignedEvent;
    }

    case "group.person.assign": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: group.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.person-assigned",
        payload: {
          groupId: group.id,
          person: command.person,
          updatedAt: occurredAt,
        },
      };
    }

    case "group.person.unassign":
    case "group.leave": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const person = group.members.find(
        (member) => member.kind === "person" && member.personId === command.personId,
      );
      if (!person) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Person '${command.personId}' is not a member of group '${group.id}'.`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: group.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.person-unassigned",
        payload: {
          groupId: group.id,
          personId: command.personId,
          updatedAt: occurredAt,
        },
      };
    }

    case "group.boss.set": {
      const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
      const nextBoss = yield* requireBotNotArchived({
        readModel,
        command,
        botId: command.bossBotId,
      });
      if (group.bossBotId === nextBoss.id && command.unassignPreviousBoss === true) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot '${nextBoss.id}' is already the boss and cannot replace and unassign itself.`,
          }),
        );
      }
      if (command.unassignPreviousBoss === true) {
        const remainingBotIds = activeGroupBotIds(readModel, group);
        if (group.bossBotId !== null) remainingBotIds.delete(group.bossBotId);
        remainingBotIds.add(nextBoss.id);
        if (remainingBotIds.size < 2) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Group '${group.id}' requires at least two active bots.`,
            }),
          );
        }
      }

      const occurredAt = yield* nowIso;
      const previousBossBotId = group.bossBotId;
      const previousBossRole =
        previousBossBotId === null || previousBossBotId === nextBoss.id
          ? null
          : command.unassignPreviousBoss === true
            ? ("unassigned" as const)
            : ("specialist" as const);
      const bossSetEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "group",
          aggregateId: group.id,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "group.boss-set",
        payload: {
          groupId: group.id,
          bossBotId: nextBoss.id,
          previousBossBotId,
          previousBossRole,
          updatedAt: occurredAt,
        },
      };
      return bossSetEvent;
    }

    case "mcp-server.create": {
      yield* requireMcpServerAbsent({
        readModel,
        command,
        mcpServerId: command.mcpServerId,
      });
      const mcpServer =
        command.transport === "stdio"
          ? {
              id: command.mcpServerId,
              name: command.name,
              transport: command.transport,
              command: command.command,
              ...(command.args !== undefined ? { args: command.args } : {}),
              enabled: command.enabled ?? true,
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
            }
          : {
              id: command.mcpServerId,
              name: command.name,
              transport: command.transport,
              url: command.url,
              enabled: command.enabled ?? true,
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
            };

      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-server",
          aggregateId: command.mcpServerId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "mcp-server.created",
        payload: { mcpServer },
      };
    }

    case "mcp-server.update": {
      const existing = yield* requireMcpServer({
        readModel,
        command,
        mcpServerId: command.mcpServerId,
      });
      const occurredAt = yield* nowIso;
      const mcpServer =
        command.transport === "stdio"
          ? {
              id: existing.id,
              name: command.name,
              transport: command.transport,
              command: command.command,
              ...(command.args !== undefined ? { args: command.args } : {}),
              enabled: existing.enabled,
              createdAt: existing.createdAt,
              updatedAt: occurredAt,
            }
          : {
              id: existing.id,
              name: command.name,
              transport: command.transport,
              url: command.url,
              enabled: existing.enabled,
              createdAt: existing.createdAt,
              updatedAt: occurredAt,
            };

      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-server",
          aggregateId: command.mcpServerId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "mcp-server.updated",
        payload: { mcpServer },
      };
    }

    case "mcp-server.delete": {
      yield* requireMcpServer({
        readModel,
        command,
        mcpServerId: command.mcpServerId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-server",
          aggregateId: command.mcpServerId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "mcp-server.deleted",
        payload: {
          mcpServerId: command.mcpServerId,
          deletedAt: occurredAt,
        },
      };
    }

    case "mcp-server.enable":
    case "mcp-server.disable": {
      const existing = yield* requireMcpServer({
        readModel,
        command,
        mcpServerId: command.mcpServerId,
      });
      const occurredAt = yield* nowIso;
      const enabled = command.type === "mcp-server.enable";
      return {
        ...(yield* withEventBase({
          aggregateKind: "mcp-server",
          aggregateId: command.mcpServerId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: enabled ? "mcp-server.enabled" : "mcp-server.disabled",
        payload: {
          mcpServer: {
            ...existing,
            enabled,
            updatedAt: occurredAt,
          },
        },
      };
    }

    case "delegation.create": {
      const delegation = command.delegation;
      yield* requireDelegationAbsent({
        readModel,
        command,
        delegationId: delegation.delegationId,
      });
      yield* requireBotNotArchived({ readModel, command, botId: delegation.parentBotId });
      yield* requireBotNotArchived({ readModel, command, botId: delegation.childBotId });
      yield* requireThread({ readModel, command, threadId: delegation.parentThreadId });
      if (delegation.childThreadId !== null) {
        yield* requireThread({ readModel, command, threadId: delegation.childThreadId });
      }

      if (delegation.billedBotId !== delegation.childBotId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${delegation.delegationId}' must bill child bot '${delegation.childBotId}'.`,
        });
      }

      const parentDelegation =
        delegation.parentDelegationId === null
          ? null
          : yield* requireDelegation({
              readModel,
              command,
              delegationId: delegation.parentDelegationId,
            });
      if (parentDelegation !== null && parentDelegation.childBotId !== delegation.parentBotId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Parent delegation '${parentDelegation.delegationId}' does not belong to bot '${delegation.parentBotId}'.`,
        });
      }

      const expectedDepth = parentDelegation === null ? 1 : parentDelegation.depth + 1;
      const expectedAncestorBotIds =
        parentDelegation === null
          ? [delegation.parentBotId]
          : [...parentDelegation.ancestorBotIds, delegation.parentBotId];
      if (
        expectedDepth > AKERU_DELEGATION_MAX_DEPTH ||
        delegation.depth !== expectedDepth ||
        !NodeUtil.isDeepStrictEqual(delegation.ancestorBotIds, expectedAncestorBotIds)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${delegation.delegationId}' has an invalid ancestor chain or depth.`,
        });
      }
      if (delegation.ancestorBotIds.includes(delegation.childBotId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${delegation.delegationId}' would create a bot cycle.`,
        });
      }

      const activeDelegationCount = readModel.delegations.filter(
        (candidate) =>
          candidate.parentBotId === delegation.parentBotId &&
          !TERMINAL_DELEGATION_STATES.has(candidate.state),
      ).length;
      if (activeDelegationCount >= AKERU_DELEGATION_MAX_CONCURRENCY) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Bot '${delegation.parentBotId}' already has ${activeDelegationCount} active delegations.`,
        });
      }
      const stateError = delegationStateError(delegation);
      if (delegation.state !== "queued" || stateError !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: stateError ?? "New delegations must start queued.",
        });
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: delegation.delegationId,
          occurredAt: delegation.createdAt,
          commandId: command.commandId,
        })),
        type: "delegation.created",
        payload: { delegation },
      };
    }

    case "delegation.state.set": {
      const current = yield* requireDelegation({
        readModel,
        command,
        delegationId: command.delegation.delegationId,
      });
      const next = command.delegation;
      if (!hasSameDelegationOwnership(current, next)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${next.delegationId}' ownership and access fields are immutable.`,
        });
      }
      if (
        (current.childThreadId !== null && next.childThreadId !== current.childThreadId) ||
        (current.childTurnId !== null && next.childTurnId !== current.childTurnId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${next.delegationId}' child ownership is immutable once assigned.`,
        });
      }
      if (next.childThreadId !== null) {
        yield* requireThread({ readModel, command, threadId: next.childThreadId });
      }
      if (!(Date.parse(next.updatedAt) >= Date.parse(current.updatedAt))) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${next.delegationId}' cannot move updatedAt backward.`,
        });
      }
      if (current.state === next.state) {
        const assignsChildOwnership =
          (current.childThreadId === null && next.childThreadId !== null) ||
          (current.childTurnId === null && next.childTurnId !== null);
        const changesOnlyChildOwnership = NodeUtil.isDeepStrictEqual(current, {
          ...next,
          childThreadId: current.childThreadId,
          childTurnId: current.childTurnId,
          updatedAt: current.updatedAt,
        });
        if (
          !NodeUtil.isDeepStrictEqual(current, next) &&
          (!assignsChildOwnership || !changesOnlyChildOwnership)
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Delegation '${next.delegationId}' cannot change data without a state transition.`,
          });
        }
      } else if (
        TERMINAL_DELEGATION_STATES.has(current.state) ||
        !DELEGATION_STATE_TRANSITIONS[
          current.state as keyof typeof DELEGATION_STATE_TRANSITIONS
        ].has(next.state)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Delegation '${next.delegationId}' cannot transition from '${current.state}' to '${next.state}'.`,
        });
      }
      const stateError = delegationStateError(next);
      if (stateError !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: stateError,
        });
      }

      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: next.delegationId,
          occurredAt: next.updatedAt,
          commandId: command.commandId,
        })),
        type: "delegation.updated",
        payload: { delegation: next },
      };
    }

    case "delegation.cancel": {
      const current = yield* requireDelegation({
        readModel,
        command,
        delegationId: command.delegationId,
      });
      const canceledAt =
        Date.parse(command.createdAt) >= Date.parse(current.updatedAt)
          ? command.createdAt
          : current.updatedAt;
      const delegation = command.keep
        ? { ...current, keep: true, updatedAt: canceledAt }
        : TERMINAL_DELEGATION_STATES.has(current.state)
          ? current
          : {
              ...current,
              state: "canceled" as const,
              result: null,
              failure: null,
              updatedAt: canceledAt,
              completedAt: canceledAt,
            };

      return {
        ...(yield* withEventBase({
          aggregateKind: "delegation",
          aggregateId: command.delegationId,
          occurredAt: delegation.updatedAt,
          commandId: command.commandId,
        })),
        type: "delegation.updated",
        payload: { delegation },
      };
    }

    case "routine.create-approved": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );
      if (existing !== undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' already exists.`,
        });
      }
      const routine = {
        id: command.routineId,
        botId: command.botId,
        targetThreadId: command.targetThreadId,
        job: command.job,
        procedure: command.procedure,
        schedule: command.schedule,
        timezone: command.timezone,
        skillAssignmentIds: command.skillAssignmentIds,
        connectorDependencies: command.connectorDependencies,
        projectId: command.projectId,
        sandbox: command.sandbox,
        approvalPolicy: command.approvalPolicy,
        procedureVersion: 1,
        approvalVersion: 1,
        enabled: false as const,
        lifecycle: "approved" as const,
        nextRunAt: null,
        lastRunAt: null,
        latestResult: null,
        latestFailure: null,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        deletedAt: null,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.approved",
        payload: { routine },
      };
    }

    case "routine.draft": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );
      if (existing?.lifecycle === "deleted") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' is deleted.`,
        });
      }
      if (
        existing !== undefined &&
        command.expectedProcedureVersion !== undefined &&
        command.expectedProcedureVersion !== existing.procedureVersion
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' procedure version changed.`,
        });
      }
      const procedureVersion = (existing?.procedureVersion ?? 0) + 1;
      const routine = {
        id: command.routineId,
        botId: command.botId,
        targetThreadId: command.targetThreadId,
        job: command.job,
        procedure: command.procedure,
        schedule: command.schedule,
        timezone: command.timezone,
        skillAssignmentIds: command.skillAssignmentIds,
        connectorDependencies: command.connectorDependencies,
        projectId: command.projectId,
        sandbox: command.sandbox,
        approvalPolicy: command.approvalPolicy,
        procedureVersion,
        approvalVersion: null,
        enabled: false as const,
        lifecycle: "draft" as const,
        nextRunAt: null,
        lastRunAt: existing?.lastRunAt ?? null,
        latestResult: existing?.latestResult ?? null,
        latestFailure: existing?.latestFailure ?? null,
        createdAt: existing?.createdAt ?? command.createdAt,
        updatedAt: command.createdAt,
        deletedAt: null,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.drafted",
        payload: { routine },
      };
    }

    case "routine.approve": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );
      if (
        existing === undefined ||
        existing.lifecycle === "deleted" ||
        existing.procedureVersion !== command.procedureVersion
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' cannot approve procedure version ${command.procedureVersion}.`,
        });
      }
      const routine = {
        ...existing,
        approvalVersion: existing.procedureVersion,
        enabled: false,
        lifecycle: "approved" as const,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.approved",
        payload: { routine },
      };
    }

    case "routine.enable": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );
      if (
        existing === undefined ||
        existing.lifecycle === "deleted" ||
        existing.approvalVersion !== existing.procedureVersion
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' requires approval before enable.`,
        });
      }
      const routine = {
        ...existing,
        enabled: true,
        lifecycle: "enabled" as const,
        nextRunAt: nextScheduledFor(
          existing.schedule,
          existing.timezone,
          Date.parse(command.createdAt),
        ),
        latestFailure: null,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.enabled",
        payload: { routine },
      };
    }

    case "routine.pause": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );
      if (existing === undefined || existing.lifecycle === "deleted") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' does not exist.`,
        });
      }
      const routine = {
        ...existing,
        enabled: false,
        lifecycle: "paused" as const,
        nextRunAt: null,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.paused",
        payload: { routine },
      };
    }

    case "routine.run":
    case "routine.run.scheduled": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );
      if (existing === undefined || existing.lifecycle === "deleted") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' does not exist.`,
        });
      }
      if (command.type === "routine.run.scheduled" && !existing.enabled) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' is not enabled.`,
        });
      }
      if (command.trigger !== "dry-run" && existing.approvalVersion !== existing.procedureVersion) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' procedure approval is stale.`,
        });
      }
      if ((readModel.routineRuns ?? []).some((run) => run.id === command.runId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine run '${command.runId}' already exists.`,
        });
      }
      const runBase = {
        id: command.runId,
        routineId: command.routineId,
        procedureVersion: existing.procedureVersion,
        status: "queued" as const,
        result: null,
        failure: null,
        usageRef: null,
        threadRef: null,
        startedAt: null,
        completedAt: null,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      const run =
        command.type === "routine.run.scheduled"
          ? {
              ...runBase,
              trigger: command.trigger,
              scheduledFor: command.scheduledFor,
            }
          : { ...runBase, trigger: command.trigger, scheduledFor: null };
      const routine = {
        ...existing,
        lifecycle: "running" as const,
        lastRunAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.running",
        payload: { routine, run },
      };
    }

    case "routine.run.start":
    case "routine.run.block":
    case "routine.run.fail":
    case "routine.run.complete":
    case "routine.run.cancel": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );
      const existingRun = (readModel.routineRuns ?? []).find((run) => run.id === command.runId);
      if (existing === undefined || existing.lifecycle === "deleted" || existingRun === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine run '${command.runId}' does not exist.`,
        });
      }
      const occurredAt =
        command.type === "routine.run.start" ? command.startedAt : command.createdAt;
      const run =
        command.type === "routine.run.start"
          ? {
              ...existingRun,
              status: "running" as const,
              threadRef: command.threadRef,
              startedAt: command.startedAt,
              updatedAt: command.startedAt,
            }
          : command.type === "routine.run.block"
            ? {
                ...existingRun,
                status: "blocked" as const,
                failure: command.failure,
                completedAt: command.createdAt,
                updatedAt: command.createdAt,
              }
            : command.type === "routine.run.fail"
              ? {
                  ...existingRun,
                  status: "failed" as const,
                  failure: command.failure,
                  usageRef: command.usageRef,
                  completedAt: command.createdAt,
                  updatedAt: command.createdAt,
                }
              : command.type === "routine.run.complete"
                ? {
                    ...existingRun,
                    status: "completed" as const,
                    result: command.result,
                    usageRef: command.usageRef,
                    completedAt: command.createdAt,
                    updatedAt: command.createdAt,
                  }
                : {
                    ...existingRun,
                    status: "canceled" as const,
                    completedAt: command.createdAt,
                    updatedAt: command.createdAt,
                  };
      const terminal = command.type !== "routine.run.start";
      const blockedOrFailed =
        command.type === "routine.run.block" || command.type === "routine.run.fail";
      const routine = {
        ...existing,
        enabled: blockedOrFailed ? false : existing.enabled,
        lifecycle:
          command.type === "routine.run.start"
            ? ("running" as const)
            : command.type === "routine.run.block"
              ? ("blocked" as const)
              : command.type === "routine.run.fail"
                ? ("failed" as const)
                : command.type === "routine.run.complete" && existing.enabled
                  ? ("enabled" as const)
                  : command.type === "routine.run.complete"
                    ? ("completed" as const)
                    : existing.enabled
                      ? ("enabled" as const)
                      : ("paused" as const),
        nextRunAt:
          command.type === "routine.run.complete"
            ? command.nextRunAt
            : blockedOrFailed
              ? null
              : existing.nextRunAt,
        lastRunAt: terminal ? occurredAt : existing.lastRunAt,
        latestResult:
          command.type === "routine.run.complete" ? command.result : existing.latestResult,
        latestFailure:
          command.type === "routine.run.block" || command.type === "routine.run.fail"
            ? command.failure
            : existing.latestFailure,
        updatedAt: occurredAt,
      };
      const type =
        command.type === "routine.run.start"
          ? ("routine.running" as const)
          : command.type === "routine.run.block"
            ? ("routine.blocked" as const)
            : command.type === "routine.run.fail"
              ? ("routine.failed" as const)
              : command.type === "routine.run.complete"
                ? ("routine.completed" as const)
                : ("routine.run-canceled" as const);
      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt,
          commandId: command.commandId,
        })),
        type,
        payload: { routine, run },
      };
    }

    case "routine.delete": {
      const existing = (readModel.routines ?? []).find(
        (routine) => routine.id === command.routineId,
      );
      if (existing === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Routine '${command.routineId}' does not exist.`,
        });
      }
      const routine = {
        ...existing,
        enabled: false,
        lifecycle: "deleted" as const,
        nextRunAt: null,
        updatedAt: command.createdAt,
        deletedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "routine",
          aggregateId: command.routineId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "routine.deleted",
        payload: { routine },
      };
    }

    case "routine.skill.assign": {
      if (
        (readModel.skillAssignments ?? []).some(
          (assignment) => assignment.id === command.assignmentId,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Skill assignment '${command.assignmentId}' already exists.`,
        });
      }
      const assignment = {
        id: command.assignmentId,
        botId: command.botId,
        skillId: command.skillId,
        name: command.name,
        description: command.description,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      };
      return {
        ...(yield* withEventBase({
          aggregateKind: "skill-assignment",
          aggregateId: command.assignmentId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "skill-assignment.assigned",
        payload: { assignment },
      };
    }

    case "routine.skill.unassign": {
      const assignment = (readModel.skillAssignments ?? []).find(
        (entry) => entry.id === command.assignmentId && entry.botId === command.botId,
      );
      if (assignment === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Skill assignment '${command.assignmentId}' does not exist.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "skill-assignment",
          aggregateId: command.assignmentId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "skill-assignment.unassigned",
        payload: {
          assignmentId: command.assignmentId,
          botId: command.botId,
          removedAt: command.createdAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.botId != null && command.groupId != null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A thread cannot belong to both a bot and a group.",
        });
      }
      if (command.botId != null) {
        yield* requireBotNotArchived({ readModel, command, botId: command.botId });
      }
      if (command.groupId != null) {
        const group = yield* requireGroup({ readModel, command, groupId: command.groupId });
        yield* requireGroupThreadCreateAuthorized({ group, command, actor });
      }
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          botId: command.botId ?? null,
          groupId: command.groupId ?? null,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Server-side twin of the client's canSettle session check: a stale
      // or raced client must not settle a thread whose session is coming
      // alive or working.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has an active session and cannot be settled`,
          }),
        );
      }
      // Pending approval / user-input requests are blocked-on-you work: a
      // raced or stale client must not park them behind a settled override
      // that would surface only after the request resolves.
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be settled`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      // Settling inside the adoption window would hide just-requested work.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be settled`,
          }),
        );
      }
      // Settling an already-settled thread re-emits with the original
      // settledAt: the engine rejects zero-event commands, and bulk-settle /
      // double-click must stay silent no-ops rather than surface errors.
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      const settledEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled" as const,
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled ? thread.settledAt : occurredAt,
          // A re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": clear states that would keep the
      // row pinned or snoozed instead of showing the new settled state.
      const companionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.pinnedAt != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unpinned" as const,
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return companionEvents.length > 0 ? [settledEvent, ...companionEvents] : settledEvent;
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // A wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
          }),
        );
      }
      // Blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed`,
          }),
        );
      }
      // A queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
          }),
        );
      }
      // Re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.voice-transcript.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.respondingBotId !== undefined) {
        yield* requireBot({ readModel, command, botId: command.respondingBotId });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: command.role,
          text: command.text,
          turnId: null,
          ...(command.respondingBotId !== undefined
            ? { respondingBotId: command.respondingBotId }
            : {}),
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(command.title !== undefined && thread.titleRegeneration != null
            ? { titleRegeneration: null }
            : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.linkedPullRequest !== undefined
            ? { linkedPullRequest: command.linkedPullRequest }
            : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }

      let respondingBotId = targetThread.botId ?? null;
      let respondingBot =
        respondingBotId === null
          ? null
          : yield* requireBot({ readModel, command, botId: respondingBotId });
      let personAssignedEvent: Omit<OrchestrationEvent, "sequence"> | null = null;
      if (targetThread.groupId !== null && targetThread.groupId !== undefined) {
        const group = yield* requireGroup({
          readModel,
          command,
          groupId: targetThread.groupId,
        });
        const selectedBotId = command.respondingBotId ?? group.bossBotId;
        if (selectedBotId === null) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `Group '${group.id}' has no boss bot that can respond.`,
            }),
          );
        }
        respondingBot = yield* requireActiveGroupMember({
          readModel,
          command,
          groupId: group.id,
          botId: selectedBotId,
        });
        respondingBotId = selectedBotId;
        const personMembers = group.members.filter((member) => member.kind === "person");
        const senderIsMember = personMembers.some(
          (member) => member.personId === command.senderPersonId,
        );
        if (command.senderPersonId === undefined) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `A person member must send turns to group '${group.id}'.`,
            }),
          );
        }
        if (!senderIsMember) {
          if (personMembers.length === 0 && command.senderCanManageGroups === true) {
            personAssignedEvent = {
              ...(yield* withEventBase({
                aggregateKind: "group",
                aggregateId: group.id,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              })),
              type: "group.person-assigned",
              payload: {
                groupId: group.id,
                person: {
                  kind: "person",
                  personId: command.senderPersonId,
                  displayName: command.senderDisplayName ?? "Host",
                },
                updatedAt: command.createdAt,
              },
            };
          } else {
            return yield* Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: `Person '${command.senderPersonId}' is not a member of group '${group.id}'.`,
              }),
            );
          }
        }
      } else if (command.respondingBotId !== undefined) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Bot mentions can only route turns on a group-owned thread.`,
          }),
        );
      }

      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          ...(command.message.channelOrigin !== undefined
            ? { channelOrigin: command.message.channelOrigin }
            : {}),
          turnId: null,
          authorPersonId: command.senderPersonId ?? null,
          authorDisplayName: command.senderDisplayName ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(respondingBot?.engine !== null && respondingBot?.engine !== undefined
            ? {
                modelSelection: {
                  instanceId: ProviderInstanceId.make(respondingBot.engine.provider),
                  model: respondingBot.engine.model,
                  ...(respondingBot.engine.options
                    ? { options: respondingBot.engine.options }
                    : {}),
                },
              }
            : command.modelSelection !== undefined
              ? { modelSelection: command.modelSelection }
              : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          respondingBotId,
          ...(command.timezone !== undefined ? { timezone: command.timezone } : {}),
          createdAt: command.createdAt,
        },
      };
      // Real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      return [
        ...(personAssignedEvent === null ? [] : [personAssignedEvent]),
        ...lifecycleResetEvents,
        userMessageEvent,
        turnStartRequestedEvent,
      ];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const responseRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
      const answerText = userInputAnswerText(command.answers);
      if (answerText === null) return responseRequestedEvent;

      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: MessageId.make(`user-input:${command.threadId}:${command.requestId}`),
          role: "user",
          text: answerText,
          turnId: thread.session?.activeTurnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };

      return [
        userMessageEvent,
        { ...responseRequestedEvent, causationEventId: userMessageEvent.eventId },
      ];
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Settle-cleanup stops are conditional: between the settle landing and
      // this command, another client may have re-engaged the thread (a turn
      // start unsettles it and brings the session alive). Commands are
      // decided serially against this read model, so checking here — not in
      // the dispatcher's pre-settle snapshot — closes that race.
      if (command.onlyIfSettled === true) {
        const sessionComingAlive =
          thread.session?.status === "starting" || thread.session?.status === "running";
        if (
          thread.settledOverride !== "settled" ||
          sessionComingAlive ||
          threadHasQueuedTurnStart(thread, command.createdAt)
        ) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `thread ${command.threadId} was re-engaged after settle; skipping session stop`,
            }),
          );
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      // Only a session coming alive is activity worth waking a settled thread
      // for — status writes like ready/stopped/error arrive after the fact and
      // must not fight a user's explicit settle. Snooze is deliberately NOT
      // cleared here: snooze never pauses the agent, so its session starting
      // or erroring is not the user re-engaging. Blocked/failed work still
      // surfaces immediately — effectiveSnoozed refuses to classify a thread
      // with a raised hand (approval / input / failure / fresh completion)
      // as snoozed, without spending the return ticket.
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !isSessionActivity) {
        return sessionSetEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, sessionSetEvent];
    }

    case "thread.message.assistant.delta": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          ...(command.attachments !== undefined ? { attachments: command.attachments } : {}),
          turnId: command.turnId ?? null,
          respondingBotId: thread.respondingBotId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          respondingBotId: thread.respondingBotId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.reaction.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (!thread.messages.some((message) => message.id === command.messageId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Message '${command.messageId}' is not visible in thread '${command.threadId}'.`,
        });
      }
      if (thread.groupId != null) {
        yield* requireActiveGroupMember({
          readModel,
          command,
          groupId: thread.groupId,
          botId: command.botId,
        });
      } else if (thread.botId !== command.botId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Bot '${command.botId}' cannot react in thread '${command.threadId}'.`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.updatedAt,
          commandId: command.commandId,
        })),
        type: "thread.message-reaction-set",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          botId: command.botId,
          emoji: command.emoji,
          present: command.present,
          updatedAt: command.updatedAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // An approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, activityAppendedEvent];
    }

    case "thread.history.restore": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
      const eventBase = (occurredAt: string) =>
        withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
          metadata: { importedHistory: true },
        });

      for (const message of command.messages) {
        events.push({
          ...(yield* eventBase(message.updatedAt)),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: message.id,
            role: message.role,
            text: message.text,
            turnId: null,
            ...(message.respondingBotId !== undefined
              ? { respondingBotId: message.respondingBotId }
              : {}),
            streaming: false,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          },
        });
      }
      for (const proposedPlan of command.proposedPlans) {
        events.push({
          ...(yield* eventBase(proposedPlan.updatedAt)),
          type: "thread.proposed-plan-upserted",
          payload: { threadId: command.threadId, proposedPlan },
        });
      }
      for (const activity of command.activities) {
        events.push({
          ...(yield* eventBase(activity.createdAt)),
          type: "thread.activity-appended",
          payload: { threadId: command.threadId, activity },
        });
      }

      if (
        command.settledOverride !== thread.settledOverride ||
        command.settledAt !== thread.settledAt
      ) {
        if (command.settledOverride === "settled") {
          const settledAt = command.settledAt ?? command.updatedAt;
          events.push({
            ...(yield* eventBase(settledAt)),
            type: "thread.settled",
            payload: { threadId: command.threadId, settledAt, updatedAt: command.updatedAt },
          });
        } else {
          events.push({
            ...(yield* eventBase(command.updatedAt)),
            type: "thread.unsettled",
            payload: {
              threadId: command.threadId,
              reason: command.settledOverride === "active" ? "user" : "activity",
              updatedAt: command.updatedAt,
            },
          });
        }
      }
      if (
        command.snoozedUntil !== (thread.snoozedUntil ?? null) ||
        command.snoozedAt !== (thread.snoozedAt ?? null)
      ) {
        if (command.snoozedUntil !== null) {
          events.push({
            ...(yield* eventBase(command.snoozedAt ?? command.updatedAt)),
            type: "thread.snoozed",
            payload: {
              threadId: command.threadId,
              snoozedUntil: command.snoozedUntil,
              snoozedAt: command.snoozedAt ?? command.updatedAt,
              updatedAt: command.updatedAt,
            },
          });
        } else {
          events.push({
            ...(yield* eventBase(command.updatedAt)),
            type: "thread.unsnoozed",
            payload: { threadId: command.threadId, reason: "user", updatedAt: command.updatedAt },
          });
        }
      }
      if (
        command.pinnedAt !== (thread.pinnedAt ?? null) ||
        command.pinOrderKey !== (thread.pinOrderKey ?? null)
      ) {
        if (command.pinnedAt !== null) {
          events.push({
            ...(yield* eventBase(command.pinnedAt)),
            type: "thread.pinned",
            payload: {
              threadId: command.threadId,
              pinnedAt: command.pinnedAt,
              ...(command.pinOrderKey !== null ? { pinOrderKey: command.pinOrderKey } : {}),
              updatedAt: command.updatedAt,
            },
          });
        } else {
          events.push({
            ...(yield* eventBase(command.updatedAt)),
            type: "thread.unpinned",
            payload: { threadId: command.threadId, updatedAt: command.updatedAt },
          });
        }
      }
      if (command.archivedAt !== thread.archivedAt) {
        if (command.archivedAt !== null) {
          events.push({
            ...(yield* eventBase(command.archivedAt)),
            type: "thread.archived",
            payload: {
              threadId: command.threadId,
              archivedAt: command.archivedAt,
              updatedAt: command.updatedAt,
            },
          });
        } else {
          events.push({
            ...(yield* eventBase(command.updatedAt)),
            type: "thread.unarchived",
            payload: { threadId: command.threadId, updatedAt: command.updatedAt },
          });
        }
      }
      if (events.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' history already matches the restore command.`,
        });
      }
      return events;
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
