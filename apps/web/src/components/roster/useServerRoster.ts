import { useAtomValue } from "@effect/atom-react";
import { BotId, type EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect } from "react";

import {
  botEnvironment,
  environmentBotsAtom,
  environmentGroupsAtom,
  environmentRosterLoadedAtom,
} from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRosterStore } from "./rosterStore";
import type { BotAvatar } from "./types";

const NO_ENVIRONMENT = "" as EnvironmentId;

/** Mirrors the primary environment's persisted bot roster into the UI store. */
export function useServerRosterSync(): void {
  const environmentId = usePrimaryEnvironmentId();
  const atomKey = environmentId ?? NO_ENVIRONMENT;
  const loaded = useAtomValue(environmentRosterLoadedAtom(atomKey));
  const bots = useAtomValue(environmentBotsAtom(atomKey));
  const groups = useAtomValue(environmentGroupsAtom(atomKey));
  const createBot = useAtomCommand(botEnvironment.create, { reportFailure: false });

  useEffect(() => {
    if (environmentId === null || !loaded) return;
    if (bots.length === 0) {
      void createBot({
        environmentId,
        input: {
          botId: BotId.make("bot-akeru"),
          name: "Akeru",
          title: "Generalist",
          label: null,
          description: null,
          avatar: { kind: "blob", shape: "circle", color: "#5B7FD4" },
          engine: null,
          sandbox: null,
          runtimeMode: "full-access",
          usageCap: null,
          groupId: null,
        },
      });
      return;
    }
    useRosterStore.getState().replaceRoster({
      bots: bots.map((bot) => ({
        ...bot,
        avatar: { ...bot.avatar },
        channelBindings: bot.channelBindings ?? [],
        pinned: false,
      })),
      groups: groups.map((group) => ({ ...group })),
    });
  }, [bots, createBot, environmentId, groups, loaded]);
}

export function useSaveBotAvatar(): (botId: string, avatar: BotAvatar) => Promise<boolean> {
  const environmentId = usePrimaryEnvironmentId();
  const bots = useAtomValue(environmentBotsAtom(environmentId ?? NO_ENVIRONMENT));
  const updateBot = useAtomCommand(botEnvironment.update, { reportFailure: false });

  return useCallback(
    async (botId: string, avatar: BotAvatar) => {
      const serverBot = bots.find((candidate) => candidate.id === botId);
      if (environmentId !== null && serverBot !== undefined) {
        const result = await updateBot({
          environmentId,
          input: { botId: serverBot.id, avatar },
        });
        return result._tag === "Success";
      }
      useRosterStore.getState().setBotAvatar(botId, avatar);
      return true;
    },
    [bots, environmentId, updateBot],
  );
}
