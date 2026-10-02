import {
  CommandId,
  MessageId,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { type ProjectionThreadRuntimeContext } from "../../Services/ProjectionSnapshotQuery.ts";
import type { createDependencies } from "./Dependencies.ts";

export function createContext({
  crypto,
  projectionThreadActivities,
  orchestrationEngine,
  projectionSnapshotQuery,
  projectionThreadMessages,
  botInbox,
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>>,
  | "crypto"
  | "projectionThreadActivities"
  | "orchestrationEngine"
  | "projectionSnapshotQuery"
  | "projectionThreadMessages"
  | "botInbox"
>) {
  const providerCommandId = (event: ProviderRuntimeEvent, tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`provider:${event.eventId}:${tag}:${uuid}`)),
    );

  const resolveNativeUserInputForTerminalTurn = (input: {
    readonly event: ProviderRuntimeEvent;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      const activities = yield* projectionThreadActivities.listUserInputLifecycleByThreadAndTurn({
        threadId: input.threadId,
        turnId: input.turnId,
      });

      const pendingRequestIds = new Set<string>();

      for (const activity of activities) {
        const payload = Predicate.isObject(activity.payload) ? activity.payload : undefined;

        if (!payload || !Predicate.isString(payload.requestId)) continue;
        const requestId = payload.requestId;

        if (activity.kind === "user-input.requested" && payload.responseMode !== "message") {
          pendingRequestIds.add(requestId);
          continue;
        }

        if (activity.kind === "user-input.resolved") {
          pendingRequestIds.delete(requestId);
          continue;
        }

        if (activity.kind !== "provider.user-input.respond.failed") continue;
        const detail = Predicate.isString(payload.detail) ? payload.detail.toLowerCase() : "";

        if (
          detail.includes("stale pending user-input request") ||
          detail.includes("unknown pending user-input request") ||
          detail.includes("unknown pending user input request") ||
          detail.includes("unknown pending codex user input request")
        ) {
          pendingRequestIds.delete(requestId);
        }
      }

      // Native callbacks cannot accept answers after their turn terminates.
      // Message-mode questions can still receive a later chat message.
      for (const requestId of pendingRequestIds) {
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId: yield* providerCommandId(input.event, "terminal-user-input-resolved"),
          threadId: input.threadId,
          activity: {
            id: EventId.make(`${input.event.eventId}:user-input-resolved:${requestId}`),
            createdAt: input.now,
            tone: "info",
            kind: "user-input.resolved",
            summary: "User input dismissed",
            payload: { requestId },
            turnId: input.turnId,
          },
          createdAt: input.now,
        });
      }
    });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadRuntimeContext = Effect.fn("resolveThreadRuntimeContext")(function* (
    threadId: ThreadId,
  ) {
    return yield* projectionSnapshotQuery
      .getThreadRuntimeContext(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  // Assistant text deltas only need to know the thread exists and is active,
  // so they reuse the context read by the thread's most recent non-delta
  // event. Every other runtime event re-reads and refreshes the entry; session
  // exit and thread session/delete/archive domain events drop it.
  const deltaRuntimeContextByThread = new Map<string, ProjectionThreadRuntimeContext>();

  const resolveThreadRuntimeContextForEvent = Effect.fn("resolveThreadRuntimeContextForEvent")(
    function* (event: ProviderRuntimeEvent) {
      const key = String(event.threadId);

      if (event.type === "content.delta") {
        const cached = deltaRuntimeContextByThread.get(key);

        if (cached) return cached;
      }

      const thread = yield* resolveThreadRuntimeContext(event.threadId);

      if (thread && event.type !== "session.exited") {
        deltaRuntimeContextByThread.set(key, thread);
      } else {
        deltaRuntimeContextByThread.delete(key);
      }

      return thread;
    },
  );

  const getThreadMessageById = Effect.fn("getThreadMessageById")(function* (
    threadId: ThreadId,
    messageId: MessageId,
  ) {
    const message = yield* projectionThreadMessages.getByMessageId({ messageId });

    return Option.filter(message, (entry) => entry.threadId === threadId).pipe(
      Option.getOrUndefined,
    );
  });

  const syncApprovalInbox = Effect.fn("syncApprovalInbox")(function* (
    event: Extract<ProviderRuntimeEvent, { type: "request.opened" | "request.resolved" }>,
    thread: {
      readonly title: string;
      readonly botId: OrchestrationThreadShell["botId"];
      readonly respondingBotId: OrchestrationThreadShell["respondingBotId"];
    },
  ) {
    const botId = thread.respondingBotId ?? thread.botId;

    if (!botId) return;
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const bot = snapshot.bots.find((candidate) => candidate.id === botId);

    if (!bot) return;
    const incidentKey = `approval:${event.requestId}`;
    yield* Effect.sync(() => {
      botInbox.reload();

      if (event.type === "request.resolved") {
        botInbox.resolve(incidentKey);

        return;
      }

      botInbox.ensureOpen({
        incidentKey,
        kind: "approval-request",
        botId,
        botName: bot.name,
        taskOrRoutine: thread.title,
        lastFailure: event.payload.detail ?? "This request needs approval.",
        nextAction: "Open the thread and approve or decline the request.",
      });
    });
  });

  return {
    providerCommandId,
    resolveNativeUserInputForTerminalTurn,
    resolveThreadDetail,
    resolveThreadRuntimeContext,
    deltaRuntimeContextByThread,
    resolveThreadRuntimeContextForEvent,
    getThreadMessageById,
    syncApprovalInbox,
  };
}
