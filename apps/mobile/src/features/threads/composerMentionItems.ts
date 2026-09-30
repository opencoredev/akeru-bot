import {
  isGroupBotMember,
  type OrchestrationBot,
  type OrchestrationGroup,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  type ComposerMentionBot,
  composerBotMentionDetail,
} from "@t3tools/shared/composerBotMentions";
import {
  BROWSER_MENTION_LABEL,
  COMPOSER_BROWSER_MENTION,
  serializeComposerBotMention,
  serializeComposerThreadMention,
} from "@t3tools/shared/composerInlineTokens";
import {
  type ComposerThreadMentionCandidate,
  rankComposerThreadMentions,
} from "@t3tools/shared/composerThreadMentions";
import { driverSupportsDelegation } from "@t3tools/shared/delegationProviders";

import type { ComposerCommandItem } from "./ComposerCommandPopover";

const THREAD_QUERY_PREFIX = "chat:";

/** Whether an `@` query names a chat explicitly, so file search can be skipped. */
export function isThreadMentionQuery(query: string): boolean {
  return query.toLowerCase().startsWith(THREAD_QUERY_PREFIX);
}

/** The part of an `@` query that filters chats: `@chat:rel` and `@rel` both match "Release". */
export function threadMentionQuery(query: string): string {
  return isThreadMentionQuery(query) ? query.slice(THREAD_QUERY_PREFIX.length) : query;
}

/**
 * A group member the `@` menu can mention. The title tells namesakes apart;
 * `canTakeWork` is false when the bot's provider cannot take handed-off work.
 */
export type ComposerMentionItemBot = ComposerMentionBot & {
  readonly title?: string;
  readonly canTakeWork?: boolean;
};

const CANNOT_TAKE_WORK = "Cannot take handed-off work";

// Marks only a saved engine on a known provider that cannot take handed-off work.
function botTakesDelegatedWork(
  bot: OrchestrationBot,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>,
): boolean {
  const engine = bot.engine;
  if (!engine) return true;
  const provider = providers.find((candidate) => candidate.instanceId === engine.provider);
  return provider === undefined || driverSupportsDelegation(provider.driver);
}

/** The active bots in a group chat, which the `@` menu offers. Direct chats offer none. */
export function groupMentionBots(
  group: OrchestrationGroup | undefined,
  bots: ReadonlyArray<OrchestrationBot>,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">> = [],
): ComposerMentionItemBot[] {
  if (!group) return [];
  const memberIds = new Set(
    group.members.filter(isGroupBotMember).map((member) => member.botId as string),
  );
  return bots
    .filter((bot) => bot.archivedAt === null && memberIds.has(bot.id))
    .map((bot) => ({
      id: bot.id,
      name: bot.name,
      title: bot.title,
      canTakeWork: botTakesDelegatedWork(bot, providers),
    }));
}

/**
 * The `@` rows that come before file results: the browser (only when this
 * environment lets bots use it), the chat's bots matched by name prefix, then
 * the visible chats ranked for the query.
 */
export function buildComposerMentionItems(input: {
  readonly query: string;
  readonly browserAvailable: boolean;
  readonly bots?: ReadonlyArray<ComposerMentionItemBot>;
  readonly threads: ReadonlyArray<ComposerThreadMentionCandidate>;
  readonly currentThreadId: string;
  readonly currentProjectId: string | null;
  readonly matchedIds: ReadonlySet<string>;
}): ComposerCommandItem[] {
  const query = input.query.toLowerCase();
  const items: ComposerCommandItem[] = [];
  if (input.browserAvailable && !isThreadMentionQuery(query) && "browser".startsWith(query)) {
    items.push({
      id: "mention:browser",
      type: "browser-mention",
      label: BROWSER_MENTION_LABEL,
      description: "Preview browser",
    });
  }
  if (!isThreadMentionQuery(query)) {
    const bots = input.bots ?? [];
    for (const bot of bots) {
      if (!bot.name.toLowerCase().startsWith(query)) continue;
      items.push({
        id: `mention:bot:${bot.id}`,
        type: "bot-mention",
        botId: bot.id,
        label: bot.name,
        description:
          bot.canTakeWork === false
            ? [composerBotMentionDetail(bot, bots), CANNOT_TAKE_WORK].filter(Boolean).join(", ")
            : (composerBotMentionDetail(bot, bots) ?? "Bot"),
      });
    }
  }
  const threads = rankComposerThreadMentions(input.threads, {
    query: threadMentionQuery(input.query),
    currentThreadId: input.currentThreadId,
    currentProjectId: input.currentProjectId,
    matchedIds: input.matchedIds,
  });
  // A path-like query is most likely a file, so only chats whose title matches precede files.
  const pathLike = !isThreadMentionQuery(query) && /[/\\.]/.test(query);
  for (const thread of threads) {
    if (pathLike && !thread.title.toLowerCase().includes(query)) continue;
    items.push({
      id: `mention:thread:${thread.id}`,
      type: "thread-mention",
      threadId: thread.id,
      label: thread.title,
      description: "Chat",
    });
  }
  return items;
}

/**
 * The token a mention row inserts. A bot always gets its `@bot:<id>` token, which
 * the editor shows as the bot's name and the server routes to that exact bot.
 */
export function composerMentionItemToken(item: ComposerCommandItem): string | null {
  switch (item.type) {
    case "browser-mention":
      return COMPOSER_BROWSER_MENTION;
    case "bot-mention":
      return serializeComposerBotMention(item.botId);
    case "thread-mention":
      return serializeComposerThreadMention(item.threadId);
    default:
      return null;
  }
}
