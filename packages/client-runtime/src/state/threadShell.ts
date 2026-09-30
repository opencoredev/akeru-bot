import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@akeru/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentThreadShell } from "./models.ts";
import { scopeThreadShell } from "./models.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import {
  arrayElementsEqual,
  parseProjectRefCollectionKey,
  parseThreadKey,
  projectRefCollectionKey,
  threadKey,
  threadRefsEqual,
} from "./entities.ts";

const EMPTY_THREADS: ReadonlyArray<OrchestrationThreadShell> = Object.freeze([]);
const EMPTY_SCOPED_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_THREAD_INDEX: ReadonlyMap<ThreadId, OrchestrationThreadShell> = new Map();
const EMPTY_THREAD_REFS_BY_PROJECT: ReadonlyMap<
  ProjectId,
  ReadonlyArray<ScopedThreadRef>
> = new Map();

/** Latest live thread per bot and per group in one environment. */
export interface LatestOwnerThreadIds {
  readonly byBot: ReadonlyMap<string, ThreadId>;
  readonly byGroup: ReadonlyMap<string, ThreadId>;
}

const EMPTY_LATEST_OWNER_THREAD_IDS: LatestOwnerThreadIds = {
  byBot: new Map(),
  byGroup: new Map(),
};

function isNewerThread(candidate: OrchestrationThreadShell, current: OrchestrationThreadShell) {
  return (
    (candidate.updatedAt.localeCompare(current.updatedAt) ||
      candidate.id.localeCompare(current.id)) > 0
  );
}

function threadIdMapsEqual(
  left: ReadonlyMap<string, ThreadId>,
  right: ReadonlyMap<string, ThreadId>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of right) {
    if (left.get(key) !== value) return false;
  }
  return true;
}

/**
 * Picks the most recently updated unarchived thread for each bot and group.
 * Ties break on thread id so the choice is stable.
 */
export function latestOwnerThreadIds(
  threads: ReadonlyArray<OrchestrationThreadShell>,
): LatestOwnerThreadIds {
  const byBot = new Map<string, OrchestrationThreadShell>();
  const byGroup = new Map<string, OrchestrationThreadShell>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.parentThreadId != null) continue;
    if (thread.botId) {
      const current = byBot.get(thread.botId);
      if (current === undefined || isNewerThread(thread, current)) byBot.set(thread.botId, thread);
    }
    if (thread.groupId) {
      const current = byGroup.get(thread.groupId);
      if (current === undefined || isNewerThread(thread, current)) {
        byGroup.set(thread.groupId, thread);
      }
    }
  }
  const ids = (source: Map<string, OrchestrationThreadShell>) =>
    new Map([...source].map(([owner, thread]) => [owner, thread.id] as const));
  return { byBot: ids(byBot), byGroup: ids(byGroup) };
}

const OWNER_KEY_SEPARATOR = "\u0000";

/** When one of a bot's own live chats last finished a turn. */
export interface BotChatCompletion {
  readonly threadId: ThreadId;
  readonly completedAt: string;
}

const EMPTY_BOT_CHAT_COMPLETIONS: ReadonlyArray<BotChatCompletion> = [];

function botChatCompletionsEqual(
  left: ReadonlyArray<BotChatCompletion>,
  right: ReadonlyArray<BotChatCompletion>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.threadId === right[index]?.threadId &&
        entry.completedAt === right[index]?.completedAt,
    )
  );
}

export function createEnvironmentThreadShellAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const environmentThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationThreadShell> =>
        get(input.snapshotAtom(environmentId))?.threads ?? EMPTY_THREADS,
    ).pipe(Atom.withLabel(`environment-threads:${environmentId}`)),
  );

  const environmentThreadIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<ThreadId, OrchestrationThreadShell> => {
      const threads = get(environmentThreadsAtom(environmentId));
      if (threads.length === 0) {
        return EMPTY_THREAD_INDEX;
      }
      return new Map(threads.map((thread) => [thread.id, thread] as const));
    }).pipe(Atom.withLabel(`environment-thread-index:${environmentId}`)),
  );

  const environmentThreadRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedThreadRef> = [];
    return Atom.make((get) => {
      const next = get(environmentThreadsAtom(environmentId))
        .map((thread) => ({
          environmentId,
          threadId: thread.id,
        }))
        .filter((ref) => {
          const thread = get(environmentThreadIndexAtom(environmentId)).get(ref.threadId);
          return thread?.parentThreadId == null;
        });
      if (threadRefsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-thread-refs:${environmentId}`));
  });

  const environmentThreadRefsByProjectAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyMap<
      ProjectId,
      ReadonlyArray<ScopedThreadRef>
    > = EMPTY_THREAD_REFS_BY_PROJECT;
    return Atom.make((get) => {
      const grouped = new Map<ProjectId, ScopedThreadRef[]>();
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        if (thread.parentThreadId != null) {
          continue;
        }
        const refs = grouped.get(thread.projectId);
        const ref = { environmentId, threadId: thread.id };
        if (refs === undefined) {
          grouped.set(thread.projectId, [ref]);
        } else {
          refs.push(ref);
        }
      }
      if (grouped.size === 0) {
        previous = EMPTY_THREAD_REFS_BY_PROJECT;
        return previous;
      }
      const next = new Map<ProjectId, ReadonlyArray<ScopedThreadRef>>();
      for (const [projectId, refs] of grouped) {
        const previousRefs = previous.get(projectId);
        next.set(
          projectId,
          previousRefs !== undefined && threadRefsEqual(previousRefs, refs) ? previousRefs : refs,
        );
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-refs-by-project:${environmentId}`));
  });

  const environmentLatestOwnerThreadIdsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous = EMPTY_LATEST_OWNER_THREAD_IDS;
    return Atom.make((get) => {
      const next = latestOwnerThreadIds(get(environmentThreadsAtom(environmentId)));
      const byBot = threadIdMapsEqual(previous.byBot, next.byBot) ? previous.byBot : next.byBot;
      const byGroup = threadIdMapsEqual(previous.byGroup, next.byGroup)
        ? previous.byGroup
        : next.byGroup;
      if (byBot !== previous.byBot || byGroup !== previous.byGroup) {
        previous = { byBot, byGroup };
      }
      return previous;
    }).pipe(Atom.withLabel(`environment-latest-owner-threads:${environmentId}`));
  });

  const latestOwnerThreadIdAtomFamily = Atom.family((key: string) => {
    const [kind, environmentId, ownerId] = key.split(OWNER_KEY_SEPARATOR) as [
      "bot" | "group",
      EnvironmentId,
      string,
    ];
    return Atom.make((get): ThreadId | null => {
      const latest = get(environmentLatestOwnerThreadIdsAtom(environmentId));
      return (kind === "bot" ? latest.byBot : latest.byGroup).get(ownerId) ?? null;
    }).pipe(Atom.withLabel(`environment-latest-owner-thread:${kind}:${environmentId}:${ownerId}`));
  });

  const botChatCompletionsAtomFamily = Atom.family((key: string) => {
    const [environmentId, botId] = key.split(OWNER_KEY_SEPARATOR) as [EnvironmentId, string];
    let previous = EMPTY_BOT_CHAT_COMPLETIONS;
    return Atom.make((get) => {
      const next: BotChatCompletion[] = [];
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        if (thread.botId !== botId || thread.archivedAt !== null || thread.parentThreadId != null) {
          continue;
        }
        const completedAt = thread.latestTurn?.completedAt;
        if (completedAt) next.push({ threadId: thread.id, completedAt });
      }
      if (!botChatCompletionsEqual(previous, next)) previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-bot-chat-completions:${environmentId}:${botId}`));
  });

  const threadShellAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previousSource: OrchestrationThreadShell | null = null;
    let previousValue: EnvironmentThreadShell | null = null;
    return Atom.make((get) => {
      const source = get(environmentThreadIndexAtom(ref.environmentId)).get(ref.threadId) ?? null;
      if (source === previousSource) {
        return previousValue;
      }
      previousSource = source;
      previousValue = source === null ? null : scopeThreadShell(ref.environmentId, source);
      return previousValue;
    }).pipe(Atom.withLabel(`environment-thread-shell:${key}`));
  });

  const threadShellsForProjectRefsAtomFamily = Atom.family((key: string) => {
    const projectRefs = parseProjectRefCollectionKey(key);
    let previous: ReadonlyArray<EnvironmentThreadShell> = [];
    return Atom.make((get) => {
      const next: EnvironmentThreadShell[] = [];
      const seen = new Set<string>();
      for (const projectRef of projectRefs) {
        const refs =
          get(environmentThreadRefsByProjectAtom(projectRef.environmentId)).get(
            projectRef.projectId,
          ) ?? EMPTY_SCOPED_THREAD_REFS;
        for (const ref of refs) {
          const key = threadKey(ref);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const thread = get(threadShellAtomFamily(key));
          if (thread !== null) {
            next.push(thread);
          }
        }
      }
      if (arrayElementsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-shells-for-projects:${key}`));
  });

  let previousThreadRefs: ReadonlyArray<ScopedThreadRef> = [];
  const threadRefsAtom = Atom.make((get) => {
    const refs: ScopedThreadRef[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      refs.push(...get(environmentThreadRefsAtom(environmentId)));
    }
    if (threadRefsEqual(previousThreadRefs, refs)) {
      return previousThreadRefs;
    }
    previousThreadRefs = refs;
    return refs;
  }).pipe(Atom.withLabel("environment-thread-refs"));

  let previousThreadShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const threadShellsAtom = Atom.make((get) => {
    const next = get(threadRefsAtom).flatMap((ref) => {
      const thread = get(threadShellAtomFamily(threadKey(ref)));
      return thread === null ? [] : [thread];
    });
    if (arrayElementsEqual(previousThreadShells, next)) {
      return previousThreadShells;
    }
    previousThreadShells = next;
    return previousThreadShells;
  }).pipe(Atom.withLabel("environment-thread-shell-list"));

  return {
    environmentThreadsAtom,
    environmentThreadIndexAtom,
    environmentThreadRefsAtom,
    environmentThreadRefsByProjectAtom,
    threadRefsAtom,
    threadShellsAtom,
    threadShellsForProjectRefsAtom: (refs: ReadonlyArray<ScopedProjectRef>) =>
      threadShellsForProjectRefsAtomFamily(projectRefCollectionKey(refs)),
    threadShellAtom: (ref: ScopedThreadRef) => threadShellAtomFamily(threadKey(ref)),
    environmentLatestOwnerThreadIdsAtom,
    /** Latest live thread id for one bot. Changes only when that bot's latest thread changes. */
    latestBotThreadIdAtom: (environmentId: EnvironmentId, botId: string) =>
      latestOwnerThreadIdAtomFamily(["bot", environmentId, botId].join(OWNER_KEY_SEPARATOR)),
    /**
     * Last completion of each live chat one bot owns. Changes only when one of those completions
     * changes, so unread dots can cover every chat without rendering on unrelated updates.
     */
    botChatCompletionsAtom: (environmentId: EnvironmentId, botId: string) =>
      botChatCompletionsAtomFamily([environmentId, botId].join(OWNER_KEY_SEPARATOR)),
    /** Latest live thread id for one group. Changes only when that group's latest thread changes. */
    latestGroupThreadIdAtom: (environmentId: EnvironmentId, groupId: string) =>
      latestOwnerThreadIdAtomFamily(["group", environmentId, groupId].join(OWNER_KEY_SEPARATOR)),
  };
}
