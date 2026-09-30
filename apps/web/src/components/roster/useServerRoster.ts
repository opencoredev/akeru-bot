import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo } from "react";

import {
  botEnvironment,
  environmentBotsAtom,
  environmentGroupsAtom,
  environmentRosterLoadedAtom,
} from "../../state/bots";
import { useEnvironmentConnectionState, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { type RosterLoadState, resolveRosterLoadState } from "./rosterRouteSelection";
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

  useEffect(() => {
    if (environmentId === null || !loaded) return;
    useRosterStore.getState().replaceRoster({
      environmentId,
      bots: bots.map((bot) => ({
        ...bot,
        avatar: { ...bot.avatar },
        channelBindings: bot.channelBindings ?? [],
        pinned: false,
      })),
      groups: groups.map((group) => ({ ...group })),
    });
  }, [bots, environmentId, groups, loaded]);
}

/**
 * What the roster shows before the primary environment's first snapshot:
 * loading, or a failure with the reason, so a roster that never arrives is
 * never a blank list.
 */
export function useRosterLoadState(): RosterLoadState {
  const environmentId = usePrimaryEnvironmentId();
  const shellError = useAtomValue(
    environmentShell.stateValueAtom(environmentId ?? NO_ENVIRONMENT),
  ).error;
  const connection = useEnvironmentConnectionState(environmentId).data;
  return useMemo(
    () => resolveRosterLoadState({ shellError: Option.getOrNull(shellError), connection }),
    [connection, shellError],
  );
}

export function useSaveBotAvatar(): (botId: string, avatar: BotAvatar) => Promise<boolean> {
  const environmentId = usePrimaryEnvironmentId();
  const bots = useAtomValue(environmentBotsAtom(environmentId ?? NO_ENVIRONMENT));
  const updateBot = useAtomCommand(botEnvironment.update, {
    reportFailure: false,
  });

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

/**
 * Moves a bot to Auto Review after the user picks "Enable Auto Review" on an
 * approval. The server already switched the live session; this keeps later turns there.
 */
export function useEnableBotAutoReview(): (botId: string) => Promise<boolean> {
  const environmentId = usePrimaryEnvironmentId();
  const bots = useAtomValue(environmentBotsAtom(environmentId ?? NO_ENVIRONMENT));
  const updateBot = useAtomCommand(botEnvironment.update, {
    reportFailure: false,
  });

  return useCallback(
    async (botId: string) => {
      const serverBot = bots.find((candidate) => candidate.id === botId);
      if (environmentId === null || serverBot === undefined) return false;
      if (serverBot.runtimeMode === "auto") return true;
      const result = await updateBot({
        environmentId,
        input: { botId: serverBot.id, runtimeMode: "auto" },
      });
      return result._tag === "Success";
    },
    [bots, environmentId, updateBot],
  );
}
