import { isGroupBotMember, type BotId, type GroupMembership } from "@t3tools/contracts";
import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import * as Effect from "effect/Effect";

/**
 * Group members named by `@bot:<id>` tokens in a message, latest mention first. Clients may
 * send the token without resolving it to respondingBotId. Plain `@Name` stays client-resolved.
 */
export function groupMentionCandidates(
  members: ReadonlyArray<GroupMembership>,
  text: string,
): ReadonlyArray<BotId> {
  const memberBotIds = members.filter(isGroupBotMember).map((member) => member.botId);
  const candidates: BotId[] = [];
  for (const token of collectComposerInlineTokens(`${text}\n`).toReversed()) {
    if (token.type !== "bot-mention") continue;
    const botId = memberBotIds.find((id) => id === token.value);
    if (botId !== undefined && !candidates.includes(botId)) candidates.push(botId);
  }
  return candidates;
}

/**
 * The bot a group turn addresses: an explicit respondingBotId, else the latest active member
 * mentioned by token, else the boss. The decider and the pre-dispatch provider and cap gates
 * share this so they always check the bot that will actually run.
 */
export const resolveGroupResponderBotId = <E, R>(input: {
  readonly group: {
    readonly members: ReadonlyArray<GroupMembership>;
    readonly bossBotId: BotId | null;
  };
  readonly respondingBotId: BotId | undefined;
  readonly text: string;
  readonly isActive: (botId: BotId) => Effect.Effect<boolean, E, R>;
}): Effect.Effect<BotId | null, E, R> =>
  Effect.gen(function* () {
    if (input.respondingBotId !== undefined) return input.respondingBotId;
    for (const botId of groupMentionCandidates(input.group.members, input.text)) {
      if (yield* input.isActive(botId)) return botId;
    }
    return input.group.bossBotId;
  });
