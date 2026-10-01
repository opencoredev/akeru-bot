import {
  AKERU_DELEGATION_TRANSITIONS,
  type AkeruDelegationPhase,
  type AkeruDelegationRecord,
  BotId,
  EventId,
  GroupId,
  isGroupBotMember,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadId,
  type TurnId,
} from "@akeru/contracts";
import * as NodeUtil from "node:util";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { requireActiveGroupMember, requireBotNotArchived } from "../commandInvariants.ts";
import type { OrchestrationDispatchActor } from "../Services/OrchestrationEngine.ts";

export type DecideCommandSequence = (input: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
  readonly actor?: OrchestrationDispatchActor;
}) => Effect.Effect<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
>;

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export function userInputAnswerText(answers: Record<string, unknown>): string | null {
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
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

export const TERMINAL_DELEGATION_PHASES = new Set<AkeruDelegationPhase["_tag"]>([
  "Failed",
  "Canceled",
  "Completed",
]);

export const isDelegationTransitionAllowed = (
  from: AkeruDelegationPhase["_tag"],
  to: AkeruDelegationPhase["_tag"],
): boolean => {
  switch (from) {
    case "Queued":
    case "Running":
    case "Blocked":
      return AKERU_DELEGATION_TRANSITIONS[from].has(to);
    default:
      return false;
  }
};

export const delegationChildThreadId = (phase: AkeruDelegationPhase): ThreadId | null =>
  phase._tag === "Queued" ? null : phase.childThreadId;

export const delegationChildTurnId = (phase: AkeruDelegationPhase): TurnId | null =>
  phase._tag === "Queued" ? null : phase.childTurnId;

export function hasSameDelegationOwnership(
  current: AkeruDelegationRecord,
  next: AkeruDelegationRecord,
): boolean {
  const { phase: _currentPhase, updatedAt: _currentUpdatedAt, ...currentOwnership } = current;
  const { phase: _nextPhase, updatedAt: _nextUpdatedAt, ...nextOwnership } = next;
  return NodeUtil.isDeepStrictEqual(currentOwnership, nextOwnership);
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
export function isStaleRequestFailureDetail(payload: Record<string, unknown> | null): boolean {
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
export function hasOpenBlockingRequest(thread: {
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
export function threadHasQueuedTurnStart(
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

export function activeGroupBotIds(
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

// Checks that the bot a chat would answer with is still active: any bot for a
// direct chat, an active member for a group chat. A chat with no bot passes.
export function requireActiveResponder(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly groupId: GroupId | null | undefined;
  readonly botId: BotId | null | undefined;
}) {
  if (input.botId === null || input.botId === undefined) return Effect.void;
  const botId = input.botId;
  return input.groupId === null || input.groupId === undefined
    ? Effect.asVoid(requireBotNotArchived({ ...input, botId }))
    : Effect.asVoid(requireActiveGroupMember({ ...input, groupId: input.groupId, botId }));
}

// The bot an assistant message is attributed to. A server-authored message may
// name a bot explicitly: an active member of a group chat, or the chat's own bot
// in a direct chat. Otherwise the thread's current responder answers.
export const resolveAssistantMessageBot = Effect.fn("resolveAssistantMessageBot")(
  function* (input: {
    readonly readModel: OrchestrationReadModel;
    readonly command: Extract<
      OrchestrationCommand,
      { type: "thread.message.assistant.delta" | "thread.message.assistant.complete" }
    >;
    readonly thread: OrchestrationReadModel["threads"][number];
  }) {
    const botId = input.command.respondingBotId;
    if (botId === undefined) return input.thread.respondingBotId ?? null;
    if (input.thread.groupId === null && input.thread.botId !== botId) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: `Bot '${botId}' cannot post in thread '${input.thread.id}'.`,
      });
    }
    yield* requireActiveResponder({
      readModel: input.readModel,
      command: input.command,
      groupId: input.thread.groupId,
      botId,
    });
    return botId;
  },
);

export function botGroupUpdatedEvent(input: {
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

export function withEventBase(
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

export type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

export type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;
