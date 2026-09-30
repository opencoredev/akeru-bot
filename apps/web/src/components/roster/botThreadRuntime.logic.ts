import type { StartThreadTurnInput } from "@akeru/client-runtime/state/threads";
import { PLACEHOLDER_THREAD_TITLE } from "@akeru/contracts";
import type {
  BotId,
  GroupId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@akeru/contracts";

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

type BotChatCandidate = {
  environmentId: string;
  id: string;
  botId?: string | null | undefined;
  parentThreadId?: string | null | undefined;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt?: string | null | undefined;
};

function isActiveBotChat(botId: string, environmentId: string, thread: BotChatCandidate): boolean {
  return (
    thread.environmentId === environmentId &&
    thread.botId === botId &&
    thread.archivedAt === null &&
    thread.parentThreadId == null &&
    thread.deletedAt == null
  );
}

function compareNewestFirst(left: BotChatCandidate, right: BotChatCandidate): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
}

/** The bot's own active chats in one environment, newest first. Child work is left out. */
export function listBotChats<TThread extends BotChatCandidate>(
  botId: string,
  environmentId: string,
  threads: readonly TThread[],
): TThread[] {
  return threads
    .filter((thread) => isActiveBotChat(botId, environmentId, thread))
    .toSorted(compareNewestFirst);
}

export function findLatestBotThreadTarget(
  botId: string,
  environmentId: string,
  threads: readonly BotChatCandidate[],
): { environmentId: string; threadId: string } | null {
  let latest: BotChatCandidate | undefined;
  for (const thread of threads) {
    if (!isActiveBotChat(botId, environmentId, thread)) continue;
    if (latest === undefined || compareNewestFirst(thread, latest) < 0) {
      latest = thread;
    }
  }
  return latest ? { environmentId: latest.environmentId, threadId: latest.id } : null;
}

/**
 * The chat a bot shows. A remembered chat path is the user's pick: while it
 * names a live chat of this bot it stays selected, even when another chat
 * replied later. Otherwise the bot shows its newest direct thread, else the
 * remembered path while a just-created thread has not reached the shell list.
 * Every surface on the bot route resolves through this, so the conversation
 * and the side panel target the same chat.
 */
export function pickBotChatTarget(
  botId: string,
  environmentId: string | null,
  latest: { environmentId: string; threadId: string } | null,
  remembered: { environmentId: string; threadId: string } | null,
  rememberedShell:
    | {
        botId?: string | null | undefined;
        parentThreadId?: string | null | undefined;
        archivedAt: string | null;
        deletedAt?: string | null | undefined;
      }
    | null
    | undefined,
): { environmentId: string; threadId: string } | null {
  if (
    remembered &&
    remembered.environmentId === environmentId &&
    rememberedShell &&
    rememberedShell.botId === botId &&
    rememberedShell.parentThreadId == null &&
    rememberedShell.archivedAt === null &&
    rememberedShell.deletedAt == null
  ) {
    return { environmentId: remembered.environmentId, threadId: remembered.threadId };
  }
  return latest ?? remembered;
}

/**
 * The bot's chat from the primary environment's shell list: the chat the user
 * opened while it is still one of the bot's active chats, else the chat per
 * `pickBotChatTarget`. The shell list leaves out child work, so pair this with
 * `isBotOwnChatShell` on the target's shell before treating it as the bot's chat.
 */
export function resolveBotThreadTarget(
  botId: string,
  environmentId: string,
  threads: Parameters<typeof findLatestBotThreadTarget>[2],
  rememberedPath: string | null | undefined,
  openThreadId: string | null = null,
) {
  const opened =
    openThreadId === null
      ? undefined
      : threads.find(
          (thread) => thread.id === openThreadId && isActiveBotChat(botId, environmentId, thread),
        );
  if (opened) return { environmentId: opened.environmentId, threadId: opened.id };
  const parsed = rememberedPath ? parseChatPath(rememberedPath) : null;
  const remembered =
    parsed?.kind === "thread" && parsed.environmentId === environmentId ? parsed : null;
  return pickBotChatTarget(
    botId,
    environmentId,
    findLatestBotThreadTarget(botId, environmentId, threads),
    remembered,
    remembered
      ? threads.find(
          (thread) =>
            thread.environmentId === remembered.environmentId && thread.id === remembered.threadId,
        )
      : null,
  );
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

type GroupThreadShell = {
  environmentId: string;
  id: string;
  groupId?: string | null | undefined;
  parentThreadId?: string | null | undefined;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt?: string | null | undefined;
};

const isActiveGroupChat = (thread: GroupThreadShell) =>
  thread.groupId != null &&
  thread.archivedAt === null &&
  thread.parentThreadId == null &&
  thread.deletedAt == null;

const isNewerThread = (thread: GroupThreadShell, than: GroupThreadShell | undefined) =>
  than === undefined ||
  (thread.updatedAt.localeCompare(than.updatedAt) || thread.id.localeCompare(than.id)) > 0;

export function findLatestGroupThreadTarget(
  groupId: string,
  environmentId: string,
  threads: readonly GroupThreadShell[],
): { environmentId: string; threadId: string } | null {
  let latest: GroupThreadShell | undefined;
  for (const thread of threads) {
    if (
      thread.environmentId === environmentId &&
      thread.groupId === groupId &&
      isActiveGroupChat(thread) &&
      isNewerThread(thread, latest)
    ) {
      latest = thread;
    }
  }
  return latest ? { environmentId: latest.environmentId, threadId: latest.id } : null;
}

export const latestGroupThreadKey = (environmentId: string, groupId: string) =>
  `${environmentId}\u0000${groupId}`;

/**
 * Every group's latest chat in one pass, keyed by `latestGroupThreadKey`, for
 * callers that would otherwise run `findLatestGroupThreadTarget` per shell.
 */
export function findLatestGroupThreadIds(
  threads: readonly GroupThreadShell[],
): ReadonlyMap<string, string> {
  const latest = new Map<string, GroupThreadShell>();
  for (const thread of threads) {
    if (thread.groupId == null || !isActiveGroupChat(thread)) continue;
    const key = latestGroupThreadKey(thread.environmentId, thread.groupId);
    if (isNewerThread(thread, latest.get(key))) latest.set(key, thread);
  }
  return new Map(Array.from(latest, ([key, thread]) => [key, thread.id] as const));
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

/** The chat a bot or group sends into while its linked chat is not in the shell list. */
export interface RetainedChat {
  readonly ownerId: string;
  readonly threadRef: ScopedThreadRef | null;
  /** Whether the shell list has shown this chat since it was retained. */
  readonly linked: boolean;
}

/**
 * The chat the bot shows. A just-created chat wins once its shell arrives, even
 * when an older chat finished a reply after it, so the screen and sends agree.
 */
export function preferRetainedChatTarget(
  retained: RetainedChat,
  target: { environmentId: string; threadId: string } | null,
  shells: readonly {
    environmentId: string;
    id: string;
    archivedAt: string | null;
    deletedAt?: string | null | undefined;
  }[],
): { environmentId: string; threadId: string } | null {
  const pending = retained.linked ? null : retained.threadRef;
  if (
    pending &&
    shells.some(
      (shell) =>
        shell.environmentId === pending.environmentId &&
        shell.id === pending.threadId &&
        shell.archivedAt === null &&
        shell.deletedAt == null,
    )
  ) {
    return { environmentId: pending.environmentId, threadId: pending.threadId };
  }
  return target;
}

/**
 * Whether a send into this chat should replace its New chat placeholder title.
 * `titledChatId` is the chat whose title a previous send already requested.
 */
export function shouldTitlePlaceholderChat(
  threadId: string,
  shellTitle: string | undefined,
  createdPlaceholderId: string | null,
  titledChatId: string | null = null,
): boolean {
  if (titledChatId === threadId) return false;
  return shellTitle === undefined
    ? createdPlaceholderId === threadId
    : shellTitle === PLACEHOLDER_THREAD_TITLE;
}

/**
 * Keeps a just-created chat until its own shell arrives. A chat the shell list has
 * shown and then dropped was archived or deleted, so once the shells have
 * loaded it is released and the next send starts a new chat instead.
 */
export function nextRetainedChat(
  current: RetainedChat,
  linkedThreadRef: ScopedThreadRef | null,
  bootstrapped: boolean,
  openThreadId: string | null = null,
): RetainedChat {
  if (linkedThreadRef) {
    if (current.linked && current.threadRef === linkedThreadRef) return current;
    // A just-created chat stays the target while the list still shows the
    // previous chat, so a send in between cannot land in the old one. Opening
    // another chat on purpose releases it, so sends follow the opened chat.
    if (
      !current.linked &&
      current.threadRef !== null &&
      (openThreadId === null || openThreadId === current.threadRef.threadId) &&
      (current.threadRef.environmentId !== linkedThreadRef.environmentId ||
        current.threadRef.threadId !== linkedThreadRef.threadId)
    ) {
      return current;
    }
    return { ownerId: current.ownerId, threadRef: linkedThreadRef, linked: true };
  }
  if (current.linked && bootstrapped) {
    return { ownerId: current.ownerId, threadRef: null, linked: false };
  }
  return current;
}
