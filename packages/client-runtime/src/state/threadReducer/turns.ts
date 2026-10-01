import { pipe } from "effect/Function";
import * as Arr from "effect/Array";

import {
  type OrchestrationCheckpointSummary,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationThread,
  type MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type TurnId,
} from "@akeru/contracts";
import type { ThreadDetailReducerResult } from "./types.ts";

import * as O from "effect/Order";

export const checkpointOrder = O.mapInput(
  O.Number,
  (cp: OrchestrationThread["checkpoints"][number]) =>
    cp.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER,
);

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Turn state to settle a still-running latest turn with when its session
 * leaves the "running" status, or null while the session is (re)starting or
 * running and the turn must stay unsettled.
 */
export function settledTurnStateForSessionStatus(
  status: OrchestrationSession["status"],
): "completed" | "interrupted" | "error" | null {
  switch (status) {
    case "idle":
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "interrupted":
    case "stopped":
      return "interrupted";
    case "starting":
    case "running":
      return null;
  }
}

export function checkpointStatusToTurnState(
  status: "ready" | "missing" | "error",
): OrchestrationLatestTurn["state"] {
  switch (status) {
    case "ready":
      return "completed";
    case "error":
      return "error";
    case "missing":
      return "completed";
  }
}

/**
 * Returns `previous` when `next` matches it field for field, otherwise `next`.
 * Streaming cases recompute the latest turn on every delta, and keeping the
 * old reference lets selectors and memos keyed on `latestTurn` skip work.
 */
export function copyLatestTurnIdentities(
  previous: OrchestrationLatestTurn | null,
  turnId: TurnId,
): Pick<OrchestrationLatestTurn, "requestMessageId" | "respondingBotId" | "sourceProposedPlan"> {
  if (previous?.turnId !== turnId) {
    return {};
  }
  return {
    ...(previous.requestMessageId !== undefined
      ? { requestMessageId: previous.requestMessageId }
      : {}),
    ...(previous.respondingBotId !== undefined
      ? { respondingBotId: previous.respondingBotId }
      : {}),
    ...(previous.sourceProposedPlan !== undefined
      ? { sourceProposedPlan: previous.sourceProposedPlan }
      : {}),
  };
}

export function reuseLatestTurn(
  previous: OrchestrationLatestTurn | null,
  next: OrchestrationLatestTurn | null,
): OrchestrationLatestTurn | null {
  if (previous === null || next === null) {
    return next;
  }
  return previous.turnId === next.turnId &&
    previous.state === next.state &&
    previous.requestedAt === next.requestedAt &&
    previous.startedAt === next.startedAt &&
    previous.completedAt === next.completedAt &&
    previous.assistantMessageId === next.assistantMessageId &&
    previous.requestMessageId === next.requestMessageId &&
    previous.respondingBotId === next.respondingBotId &&
    previous.sourceProposedPlan?.threadId === next.sourceProposedPlan?.threadId &&
    previous.sourceProposedPlan?.planId === next.sourceProposedPlan?.planId
    ? previous
    : next;
}

export function rebindCheckpointAssistantMessage(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
  turnId: TurnId,
  messageId: MessageId,
): ReadonlyArray<OrchestrationCheckpointSummary> {
  let next: OrchestrationCheckpointSummary[] | undefined;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const entry = checkpoints[index]!;
    if (entry.turnId !== turnId || entry.assistantMessageId === messageId) continue;
    next ??= checkpoints.slice();
    next[index] = { ...entry, assistantMessageId: messageId };
  }
  return next ?? checkpoints;
}

export function retainMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
): OrchestrationMessage[] {
  // Keep messages that belong to a retained turn, plus system messages and
  // messages without a turn binding (pre-turn-0 user messages).
  return Arr.filter(messages, (message) => {
    if (message.role === "system") {
      return true;
    }
    if (message.turnId === null) {
      return true;
    }
    return retainedTurnIds.has(message.turnId);
  });
}

export function applyTurnStartRequestedEvent(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { readonly type: "thread.turn-start-requested" }>,
): ThreadDetailReducerResult {
  return {
    kind: "updated",
    thread: {
      ...thread,
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      runtimeMode: event.payload.runtimeMode,
      interactionMode: event.payload.interactionMode,
      updatedAt: event.occurredAt,
    },
  };
}

export function applyTurnInterruptRequestedEvent(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { readonly type: "thread.turn-interrupt-requested" }>,
): ThreadDetailReducerResult {
  if (event.payload.turnId === undefined) {
    return { kind: "unchanged" };
  }
  const latestTurn = thread.latestTurn;
  if (latestTurn === null || latestTurn.turnId !== event.payload.turnId) {
    return { kind: "unchanged" };
  }
  return {
    kind: "updated",
    thread: {
      ...thread,
      latestTurn: {
        ...latestTurn,
        state: "interrupted",
        startedAt: latestTurn.startedAt ?? event.payload.createdAt,
        completedAt: latestTurn.completedAt ?? event.payload.createdAt,
      },
      updatedAt: event.occurredAt,
    },
  };
}

export function applySessionSetEvent(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { readonly type: "thread.session-set" }>,
): ThreadDetailReducerResult {
  // Leaving the "running" session status is the turn-end signal: settle a
  // still-running latest turn so its duration reflects the whole turn.
  const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
  const latestTurn = reuseLatestTurn(
    thread.latestTurn,
    event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
      ? {
          turnId: event.payload.session.activeTurnId,
          state: "running",
          requestedAt:
            thread.latestTurn?.turnId === event.payload.session.activeTurnId
              ? thread.latestTurn.requestedAt
              : event.payload.session.updatedAt,
          startedAt:
            thread.latestTurn?.turnId === event.payload.session.activeTurnId
              ? (thread.latestTurn.startedAt ?? event.payload.session.updatedAt)
              : event.payload.session.updatedAt,
          completedAt: null,
          assistantMessageId:
            thread.latestTurn?.turnId === event.payload.session.activeTurnId
              ? thread.latestTurn.assistantMessageId
              : null,
          ...copyLatestTurnIdentities(thread.latestTurn, event.payload.session.activeTurnId),
        }
      : thread.latestTurn !== null &&
          thread.latestTurn.state === "running" &&
          settledTurnState !== null
        ? {
            ...thread.latestTurn,
            state: settledTurnState,
            // A running turn's completedAt can only hold a mid-turn
            // placeholder checkpoint timestamp — the session leaving
            // "running" is the authoritative turn end.
            completedAt: event.payload.session.updatedAt,
          }
        : thread.latestTurn,
  );

  return {
    kind: "updated",
    thread: {
      ...thread,
      session: event.payload.session,
      latestTurn,
      updatedAt: event.occurredAt,
    },
  };
}

export function applySessionStopRequestedEvent(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { readonly type: "thread.session-stop-requested" }>,
): ThreadDetailReducerResult {
  return thread.session === null
    ? { kind: "unchanged" }
    : {
        kind: "updated",
        thread: {
          ...thread,
          session: {
            ...thread.session,
            status: "stopped",
            activeTurnId: null,
            updatedAt: event.payload.createdAt,
          },
          updatedAt: event.occurredAt,
        },
      };
}

export function applyTurnDiffCompletedEvent(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { readonly type: "thread.turn-diff-completed" }>,
): ThreadDetailReducerResult {
  const checkpoint: OrchestrationCheckpointSummary = {
    turnId: event.payload.turnId,
    checkpointTurnCount: event.payload.checkpointTurnCount,
    checkpointRef: event.payload.checkpointRef,
    status: event.payload.status,
    files: event.payload.files,
    assistantMessageId: event.payload.assistantMessageId,
    completedAt: event.payload.completedAt,
  };

  const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
  // Don't overwrite a non-missing checkpoint with a missing one.
  if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
    return { kind: "unchanged" };
  }

  const checkpoints = pipe(
    thread.checkpoints,
    Arr.filter((entry) => entry.turnId !== checkpoint.turnId),
    Arr.append(checkpoint),
    Arr.sort(checkpointOrder),
  );

  // Mid-turn diff updates produce placeholder checkpoints; record the
  // checkpoint, but don't settle a turn its session is still running.
  const diffTurnStillRunning =
    thread.session?.status === "running" && thread.session.activeTurnId === event.payload.turnId;
  const latestTurn =
    !diffTurnStillRunning &&
    (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
      ? {
          turnId: event.payload.turnId,
          state:
            thread.latestTurn?.state === "interrupted"
              ? "interrupted"
              : checkpointStatusToTurnState(event.payload.status),
          requestedAt: thread.latestTurn?.requestedAt ?? event.payload.completedAt,
          startedAt: thread.latestTurn?.startedAt ?? event.payload.completedAt,
          completedAt: event.payload.completedAt,
          assistantMessageId: event.payload.assistantMessageId,
        }
      : thread.latestTurn;

  return {
    kind: "updated",
    thread: { ...thread, checkpoints, latestTurn, updatedAt: event.occurredAt },
  };
}

export function applyRevertedEvent(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { readonly type: "thread.reverted" }>,
): ThreadDetailReducerResult {
  const checkpoints = pipe(
    thread.checkpoints,
    Arr.filter(
      (entry) =>
        entry.checkpointTurnCount !== undefined &&
        entry.checkpointTurnCount <= event.payload.turnCount,
    ),
    Arr.sort(checkpointOrder),
  );

  const retainedTurnIds = new Set(Arr.map(checkpoints, (entry) => entry.turnId));
  const messages = retainMessagesAfterRevert(thread.messages, retainedTurnIds);
  const proposedPlans = pipe(
    thread.proposedPlans,
    Arr.filter((plan) => plan.turnId === null || retainedTurnIds.has(plan.turnId)),
  );
  const activities = pipe(
    thread.activities,
    Arr.filter((activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId)),
  );
  const latestCheckpoint = checkpoints.at(-1) ?? null;

  return {
    kind: "updated",
    thread: {
      ...thread,
      checkpoints,
      messages,
      proposedPlans,
      activities,
      latestTurn:
        latestCheckpoint === null
          ? null
          : {
              turnId: latestCheckpoint.turnId,
              state: checkpointStatusToTurnState(latestCheckpoint.status),
              requestedAt: latestCheckpoint.completedAt,
              startedAt: latestCheckpoint.completedAt,
              completedAt: latestCheckpoint.completedAt,
              assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
            },
      updatedAt: event.occurredAt,
    },
  };
}
