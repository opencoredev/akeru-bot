import type {
  EnvironmentId,
  OrchestrationBot,
  OrchestrationGroup,
  OrchestrationShellSnapshot,
  ThreadId,
} from "@akeru/contracts";

export interface ArchivedChat {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly archivedAt: string;
}

/** Archived chats that belonged to one bot or group, newest archive first. */
export interface ArchivedChatSection {
  readonly key: string;
  readonly kind: "bot" | "group" | "other";
  /** The owner's name, or null when neither snapshot knows it any more. */
  readonly name: string | null;
  readonly chats: ReadonlyArray<ArchivedChat>;
}

/**
 * Groups an environment's archived chats by the bot or group they belong to.
 * Work a bot handed to another bot only ever showed as a card in its parent
 * chat, so it is left out here too. Sections are ordered by their most
 * recently archived chat.
 */
export function buildArchivedChatSections(input: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot | null;
  readonly bots: ReadonlyArray<OrchestrationBot>;
  readonly groups: ReadonlyArray<OrchestrationGroup>;
}): ArchivedChatSection[] {
  const { snapshot } = input;
  if (!snapshot) return [];
  const botNames = new Map<string, string>();
  for (const bot of [...snapshot.bots, ...input.bots]) botNames.set(bot.id, bot.name);
  const groupNames = new Map<string, string>();
  for (const group of [...snapshot.groups, ...input.groups]) groupNames.set(group.id, group.name);

  const sections = new Map<
    string,
    { section: Omit<ArchivedChatSection, "chats">; chats: ArchivedChat[] }
  >();
  for (const thread of snapshot.threads) {
    if (thread.parentThreadId != null || thread.archivedAt === null) continue;
    const owner = thread.groupId
      ? { kind: "group" as const, ownerId: thread.groupId, name: groupNames.get(thread.groupId) }
      : thread.botId
        ? { kind: "bot" as const, ownerId: thread.botId, name: botNames.get(thread.botId) }
        : { kind: "other" as const, ownerId: null, name: undefined };
    const key = `${owner.kind}:${owner.ownerId ?? ""}`;
    const entry = sections.get(key) ?? {
      section: { key, kind: owner.kind, name: owner.name ?? null },
      chats: [],
    };
    entry.chats.push({
      environmentId: input.environmentId,
      threadId: thread.id,
      title: thread.title,
      archivedAt: thread.archivedAt,
    });
    sections.set(key, entry);
  }

  const newestFirst = (left: ArchivedChat, right: ArchivedChat) =>
    right.archivedAt.localeCompare(left.archivedAt) || right.threadId.localeCompare(left.threadId);
  return [...sections.values()]
    .map(({ section, chats }) => ({ ...section, chats: chats.toSorted(newestFirst) }))
    .toSorted(
      (left, right) =>
        newestFirst(left.chats[0]!, right.chats[0]!) || left.key.localeCompare(right.key),
    );
}
