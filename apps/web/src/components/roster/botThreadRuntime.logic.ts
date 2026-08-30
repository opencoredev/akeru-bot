import type { StartThreadTurnInput } from "@t3tools/client-runtime/state/threads";
import type {
  BotId,
  GroupId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";

const botTurnSubmissions = new Map<
  string,
  { readonly previousTurnId: string | null; readonly token: symbol }
>();

export const BOT_TURN_SUBMISSION_FALLBACK_RELEASE_MS = 15_000;

export function reserveBotTurnSubmission(
  key: string,
  previousTurnId: string | null = null,
): (() => void) | null {
  if (botTurnSubmissions.has(key)) return null;
  const token = Symbol(key);
  botTurnSubmissions.set(key, { previousTurnId, token });
  return () => {
    if (botTurnSubmissions.get(key)?.token === token) botTurnSubmissions.delete(key);
  };
}

export function releaseBotTurnSubmissionAfterSettlement(
  key: string,
  latestTurn: { readonly turnId: string; readonly state: string } | null | undefined,
): boolean {
  const submission = botTurnSubmissions.get(key);
  if (
    !submission ||
    !latestTurn ||
    latestTurn.turnId === submission.previousTurnId ||
    latestTurn.state === "running"
  ) {
    return false;
  }
  botTurnSubmissions.delete(key);
  return true;
}

export function scheduleBotTurnSubmissionFallbackRelease(
  release: () => void,
  delayMs = BOT_TURN_SUBMISSION_FALLBACK_RELEASE_MS,
): void {
  globalThis.setTimeout(release, delayMs);
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
