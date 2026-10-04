import {
  type BotEngine,
  type ModelCapabilities,
  type ModelSelection,
  type OrchestrationBot,
  type ServerConfig,
} from "@akeru/contracts";
import { botEngineFromModelSelection, botEngineModelSelection } from "@akeru/shared/model";

export type ThreadBotRef = {
  readonly botId?: string | null | undefined;
  readonly groupId?: string | null | undefined;
};

/**
 * The bot whose engine a chat runs on: the live bot of a direct chat. Group
 * chats pick a responder per turn and plain chats have no bot, so both keep
 * the thread's own selection and must never write a bot's engine.
 */
export function threadEngineBot(
  thread: ThreadBotRef | null | undefined,
  bots: ReadonlyArray<OrchestrationBot>,
): OrchestrationBot | null {
  if (!thread?.botId || (thread.groupId ?? null) !== null) return null;

  return bots.find((bot) => bot.id === thread.botId && bot.archivedAt === null) ?? null;
}

/**
 * The selection a chat shows and sends with. A direct bot's saved engine wins
 * over a stale draft, as the server does when the turn starts; a bot without
 * an engine runs whatever the chat has selected.
 */
export function effectiveThreadModelSelection(input: {
  readonly bot: OrchestrationBot | null;
  readonly draftSelection: ModelSelection | null | undefined;
  readonly threadSelection: ModelSelection;
}): ModelSelection {
  return input.bot?.engine
    ? botEngineModelSelection(input.bot.engine)
    : (input.draftSelection ?? input.threadSelection);
}

/** What the server says a model's options are; null or undefined when it cannot say. */
export function serverModelCapabilities(
  config: ServerConfig | null | undefined,
  selection: ModelSelection,
): ModelCapabilities | null | undefined {
  return config?.providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((model) => model.slug === selection.model)?.capabilities;
}

/** The engine a direct bot saves for a picked selection, keeping only chosen options. */
export function threadBotEngineUpdate(
  config: ServerConfig | null | undefined,
  selection: ModelSelection,
): BotEngine {
  return botEngineFromModelSelection(selection, serverModelCapabilities(config, selection));
}
