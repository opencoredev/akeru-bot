import type { MastraDBMessage } from "@mastra/core/agent-controller";

export const AKERU_RECENT_TURN_LIMIT = 30;
export const AKERU_RECENT_TOKEN_LIMIT = 64_000;

interface ConversationTurn {
  readonly messages: ReadonlyArray<MastraDBMessage>;
  readonly estimatedTokens: number;
  readonly required: boolean;
}

function estimatedTokens(message: MastraDBMessage): number {
  return Math.ceil(JSON.stringify(message.content).length / 4);
}

function conversationTurns(
  messages: ReadonlyArray<MastraDBMessage>,
  requiredMessageIds: ReadonlySet<string>,
): ReadonlyArray<ConversationTurn> {
  const turns: MastraDBMessage[][] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user" || turns.length === 0) turns.push([]);
    turns.at(-1)!.push(message);
  }
  return turns.flatMap((turn) => {
    const required = turn.some((message) => requiredMessageIds.has(message.id));
    const complete = turn.some((message) => message.role === "assistant");
    return complete || required
      ? [
          {
            messages: turn,
            estimatedTokens: turn.reduce((total, message) => total + estimatedTokens(message), 0),
            required,
          },
        ]
      : [];
  });
}

export function selectRecentConversation(
  messages: ReadonlyArray<MastraDBMessage>,
  options: {
    readonly requiredMessageIds?: ReadonlySet<string>;
    readonly turnLimit?: number;
    readonly tokenLimit?: number;
  } = {},
): ReadonlyArray<MastraDBMessage> {
  const requiredMessageIds = options.requiredMessageIds ?? new Set<string>();
  const turnLimit = options.turnLimit ?? AKERU_RECENT_TURN_LIMIT;
  const tokenLimit = options.tokenLimit ?? AKERU_RECENT_TOKEN_LIMIT;
  const turns = conversationTurns(messages, requiredMessageIds);
  const selected = new Set<number>();
  let selectedTokens = 0;
  let optionalTurns = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const isNewest = index === turns.length - 1;
    const withinTurnLimit = optionalTurns < turnLimit;
    const withinTokenLimit = selectedTokens + turn.estimatedTokens <= tokenLimit;
    if (!turn.required && !isNewest && (!withinTurnLimit || !withinTokenLimit)) continue;
    selected.add(index);
    selectedTokens += turn.estimatedTokens;
    if (!turn.required) optionalTurns += 1;
  }

  return turns.flatMap((turn, index) => (selected.has(index) ? turn.messages : []));
}
