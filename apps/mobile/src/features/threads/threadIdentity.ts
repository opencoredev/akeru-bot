import {
  isGroupBotMember,
  type OrchestrationBot,
  type OrchestrationGroup,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/**
 * Bot members of a group, boss first — the avatars that stand in for a group
 * chat in the roster row and thread header (a two-avatar stack, like the web
 * roster's GroupMemberStack).
 */
export function groupChatBots(
  group: OrchestrationGroup,
  bots: ReadonlyArray<OrchestrationBot>,
): ReadonlyArray<OrchestrationBot> {
  const memberIds = new Set(
    group.members.filter(isGroupBotMember).map((member) => member.botId as string),
  );
  return bots
    .filter((bot) => bot.archivedAt === null && memberIds.has(bot.id))
    .slice()
    .sort((a, b) => {
      if (a.id === group.bossBotId) return -1;
      if (b.id === group.bossBotId) return 1;
      return 0;
    });
}

export interface ThreadIdentity {
  /** Bold title: group name for group chats, bot or provider name otherwise. */
  readonly title: string;
  /** Bots whose avatars represent the row: the group's members or the one bot. */
  readonly bots: ReadonlyArray<OrchestrationBot>;
  /** Seed for the blob avatar when no bot avatar exists. */
  readonly avatarSeed: string;
  /** True for group chats — callers render a member stack instead of one blob. */
  readonly isGroup: boolean;
}

/**
 * Who the chat reads as in the roster and thread header. A group chat is the
 * group itself (name + member stack); a bot chat is the bot; a plain chat
 * falls back to the provider name, then its own title so a row is never
 * untitled.
 */
export function resolveThreadIdentity(input: {
  readonly thread: Pick<EnvironmentThreadShell, "id" | "title" | "botId" | "groupId">;
  readonly bots: ReadonlyArray<OrchestrationBot>;
  readonly groups: ReadonlyArray<OrchestrationGroup>;
  readonly providerDriver: string | null;
  readonly providerName: (driver: string | null) => string | null;
}): ThreadIdentity {
  const { thread, bots, groups, providerDriver, providerName } = input;
  const group =
    thread.groupId != null
      ? (groups.find((candidate) => candidate.id === thread.groupId) ?? null)
      : null;
  if (group !== null) {
    return {
      title: group.name,
      bots: groupChatBots(group, bots),
      avatarSeed: `${thread.id}`,
      isGroup: true,
    };
  }
  const bot =
    thread.botId != null ? (bots.find((candidate) => candidate.id === thread.botId) ?? null) : null;
  return {
    title: bot?.name ?? providerName(providerDriver) ?? thread.title,
    bots: bot === null ? [] : [bot],
    avatarSeed: providerDriver ?? `${thread.id}`,
    isGroup: false,
  };
}
