import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type OrchestrationBot } from "@akeru/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { environmentBotsAtom } from "./bots";
import { threadEngineBot, type ThreadBotRef } from "./thread-bot-engine";

const NO_BOTS = Atom.make<ReadonlyArray<OrchestrationBot>>([]);

/** The live bot whose engine the selected chat runs on, following environment snapshots. */
export function useThreadEngineBot(
  environmentId: EnvironmentId | null | undefined,
  thread: ThreadBotRef | null | undefined,
): OrchestrationBot | null {
  const bots = useAtomValue(environmentId ? environmentBotsAtom(environmentId) : NO_BOTS);
  const botId = thread?.botId ?? null;
  const groupId = thread?.groupId ?? null;

  return useMemo(() => threadEngineBot({ botId, groupId }, bots), [botId, bots, groupId]);
}
