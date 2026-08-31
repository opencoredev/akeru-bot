import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import type {
  BotId,
  GroupId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

const botTurnSubmissions = new Map<
  string,
  {
    readonly requestMessageId: string | null;
    readonly token: symbol;
  }
>();

export function reserveBotTurnSubmission(key: string): (() => void) | null {
  if (botTurnSubmissions.has(key)) return null;
  const token = Symbol(key);
  botTurnSubmissions.set(key, { requestMessageId: null, token });
  return () => {
    if (botTurnSubmissions.get(key)?.token === token) botTurnSubmissions.delete(key);
  };
}

export function acceptBotTurnSubmission(key: string, requestMessageId: string): void {
  const submission = botTurnSubmissions.get(key);
  if (submission) botTurnSubmissions.set(key, { ...submission, requestMessageId });
}

export function releaseBotTurnSubmissionAfterObservation(
  key: string,
  latestTurn: Pick<OrchestrationLatestTurn, "requestMessageId" | "state"> | null | undefined,
  activities: readonly Pick<OrchestrationThreadActivity, "kind" | "payload">[],
): boolean {
  const submission = botTurnSubmissions.get(key);
  if (!submission?.requestMessageId) return false;

  const matchingTurn = latestTurn?.requestMessageId === submission.requestMessageId;
  if (matchingTurn && latestTurn.state === "running") return false;

  const matchingTurnSettled = matchingTurn;
  const providerStartFailed = activities.some((activity) => {
    if (
      activity.kind !== "provider.turn.start.failed" ||
      typeof activity.payload !== "object" ||
      activity.payload === null ||
      !("requestId" in activity.payload) ||
      typeof activity.payload.requestId !== "string"
    ) {
      return false;
    }
    return activity.payload.requestId === submission.requestMessageId;
  });
  if (!matchingTurnSettled && !providerStartFailed) return false;

  botTurnSubmissions.delete(key);
  return true;
}

export function reserveBotTurnSubmissionAfterObservation(
  key: string,
  latestTurn: Pick<OrchestrationLatestTurn, "requestMessageId" | "state"> | null | undefined,
  activities: readonly Pick<OrchestrationThreadActivity, "kind" | "payload">[],
): (() => void) | null {
  releaseBotTurnSubmissionAfterObservation(key, latestTurn, activities);
  return reserveBotTurnSubmission(key);
}

export async function joinOrStartThreadCreate<T>(input: {
  getRetained: () => T | null;
  inFlight: { current: Promise<T | null> | null };
  start: () => Promise<T | null>;
}): Promise<T | null> {
  const existing = input.getRetained();
  if (existing) return existing;
  const pending = (input.inFlight.current ??= input.start());
  try {
    const created = await pending;
    return input.getRetained() ?? created;
  } finally {
    if (input.inFlight.current === pending) input.inFlight.current = null;
  }
}

export function buildBotTurnStartInput(input: {
  botId: BotId;
  threadId: ThreadId;
  projectId: ProjectId;
  title: string;
  message: StartThreadTurnInput["message"];
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  createdAt: string;
  createThread: boolean;
}): StartThreadTurnInput {
  return {
    threadId: input.threadId,
    message: input.message,
    modelSelection: input.modelSelection,
    titleSeed: input.title,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    ...(input.createThread
      ? {
          bootstrap: {
            createThread: {
              projectId: input.projectId,
              botId: input.botId,
              title: input.title,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              branch: null,
              worktreePath: null,
              createdAt: input.createdAt,
            },
          },
        }
      : {}),
    createdAt: input.createdAt,
  };
}

export function buildGroupTurnStartInput(input: {
  groupId: GroupId;
  respondingBotId?: BotId;
  threadId: ThreadId;
  projectId: ProjectId;
  title: string;
  message: StartThreadTurnInput["message"];
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  createdAt: string;
  createThread: boolean;
}): StartThreadTurnInput {
  return {
    threadId: input.threadId,
    message: input.message,
    modelSelection: input.modelSelection,
    titleSeed: input.title,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    ...(input.respondingBotId ? { respondingBotId: input.respondingBotId } : {}),
    ...(input.createThread
      ? {
          bootstrap: {
            createThread: {
              projectId: input.projectId,
              groupId: input.groupId,
              title: input.title,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              branch: null,
              worktreePath: null,
              createdAt: input.createdAt,
            },
          },
        }
      : {}),
    createdAt: input.createdAt,
  };
}

export function findLatestBotThreadTarget(
  botId: string,
  environmentId: string,
  threads: readonly {
    environmentId: string;
    id: string;
    botId?: string | null | undefined;
    updatedAt: string;
    archivedAt: string | null;
    deletedAt?: string | null | undefined;
  }[],
): { environmentId: string; threadId: string } | null {
  const latest = threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.botId === botId &&
        thread.archivedAt === null &&
        thread.deletedAt == null,
    )
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
    )[0];
  return latest ? { environmentId: latest.environmentId, threadId: latest.id } : null;
}

export function findLatestGroupThreadTarget(
  groupId: string,
  environmentId: string,
  threads: readonly {
    environmentId: string;
    id: string;
    groupId?: string | null | undefined;
    updatedAt: string;
    archivedAt: string | null;
    deletedAt?: string | null | undefined;
  }[],
): { environmentId: string; threadId: string } | null {
  const latest = threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.groupId === groupId &&
        thread.archivedAt === null &&
        thread.deletedAt == null,
    )
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
    )[0];
  return latest ? { environmentId: latest.environmentId, threadId: latest.id } : null;
}
