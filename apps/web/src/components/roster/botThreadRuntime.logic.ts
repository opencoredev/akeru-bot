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

import { parseChatPath } from "./roster.logic";

export function createBotTurnSubmissionQueue() {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(submission: () => Promise<T>): Promise<T> {
      const result = tail.then(submission, submission);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
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
    parentThreadId?: string | null | undefined;
    updatedAt: string;
    archivedAt: string | null;
    deletedAt?: string | null | undefined;
  }[],
): { environmentId: string; threadId: string } | null {
  let latest: (typeof threads)[number] | undefined;
  for (const thread of threads) {
    if (
      thread.environmentId !== environmentId ||
      thread.botId !== botId ||
      thread.archivedAt !== null ||
      thread.parentThreadId != null ||
      thread.deletedAt != null
    ) {
      continue;
    }
    if (
      latest === undefined ||
      (thread.updatedAt.localeCompare(latest.updatedAt) || thread.id.localeCompare(latest.id)) > 0
    ) {
      latest = thread;
    }
  }
  return latest ? { environmentId: latest.environmentId, threadId: latest.id } : null;
}

/**
 * The bot's own chat: its newest direct thread, else the remembered chat path
 * while a just-created thread has not reached the shell list yet. The shell
 * list leaves out child work, so pair this with `isBotOwnChatShell` on the
 * target's shell before treating it as the bot's chat.
 */
export function resolveBotThreadTarget(
  botId: string,
  environmentId: string,
  threads: Parameters<typeof findLatestBotThreadTarget>[2],
  rememberedPath: string | null | undefined,
) {
  const latest = findLatestBotThreadTarget(botId, environmentId, threads);
  if (latest) return latest;
  const remembered = rememberedPath ? parseChatPath(rememberedPath) : null;
  return remembered?.kind === "thread" && remembered.environmentId === environmentId
    ? remembered
    : null;
}

/**
 * Whether a resolved target's shell can be the bot's own chat. Child work
 * (delegated threads) only ever shows as cards in the parent chat, and a
 * remembered path can point at child work or another owner's thread. A shell
 * that has not loaded yet still counts, so a just-created chat stays linked.
 */
export function isBotOwnChatShell(
  botId: string,
  shell: {
    botId?: string | null | undefined;
    parentThreadId?: string | null | undefined;
  } | null,
): boolean {
  return shell === null || (shell.parentThreadId == null && shell.botId === botId);
}

export function findLatestGroupThreadTarget(
  groupId: string,
  environmentId: string,
  threads: readonly {
    environmentId: string;
    id: string;
    groupId?: string | null | undefined;
    parentThreadId?: string | null | undefined;
    updatedAt: string;
    archivedAt: string | null;
    deletedAt?: string | null | undefined;
  }[],
): { environmentId: string; threadId: string } | null {
  let latest: (typeof threads)[number] | undefined;
  for (const thread of threads) {
    if (
      thread.environmentId !== environmentId ||
      thread.groupId !== groupId ||
      thread.archivedAt !== null ||
      thread.parentThreadId != null ||
      thread.deletedAt != null
    ) {
      continue;
    }
    if (
      latest === undefined ||
      (thread.updatedAt.localeCompare(latest.updatedAt) || thread.id.localeCompare(latest.id)) > 0
    ) {
      latest = thread;
    }
  }
  return latest ? { environmentId: latest.environmentId, threadId: latest.id } : null;
}

export function findUnhandledMcpAuthorization(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly payload: unknown;
  }>,
  handledIds: ReadonlySet<string>,
): { readonly activityId: string; readonly url: string } | null {
  for (const activity of activities) {
    if (activity.kind !== "mcp.oauth.authorization-required" || handledIds.has(activity.id)) {
      continue;
    }
    if (!activity.payload || typeof activity.payload !== "object") continue;
    const authorizationUrl = (activity.payload as Record<string, unknown>).authorizationUrl;
    if (typeof authorizationUrl !== "string") continue;
    try {
      const url = new URL(authorizationUrl);
      if (url.protocol === "https:") return { activityId: activity.id, url: url.href };
    } catch {
      // Ignore malformed server data.
    }
  }
  return null;
}
