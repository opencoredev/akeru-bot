import { useAtomValue } from "@effect/atom-react";
import { createBotEnvironmentAtoms } from "@t3tools/client-runtime/state/bots";
import type { EnvironmentId, OrchestrationBot, OrchestrationGroup } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

const EMPTY_BOTS: ReadonlyArray<OrchestrationBot> = Object.freeze([]);
const EMPTY_GROUPS: ReadonlyArray<OrchestrationGroup> = Object.freeze([]);

export const botEnvironment = createBotEnvironmentAtoms(connectionAtomRuntime);

export const environmentBotsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<OrchestrationBot> =>
      get(environmentSnapshotAtom(environmentId))?.bots ?? EMPTY_BOTS,
  ).pipe(Atom.withLabel(`mobile-bots:${environmentId}`)),
);

export const environmentGroupsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<OrchestrationGroup> =>
      get(environmentSnapshotAtom(environmentId))?.groups ?? EMPTY_GROUPS,
  ).pipe(Atom.withLabel(`mobile-groups:${environmentId}`)),
);

const NO_BOT_NAMES_ATOM = Atom.make("[]").pipe(Atom.withLabel("mobile-bot-names:empty"));
// Keyed by the newline-joined bot ids. The value is a JSON string so the atom only
// notifies when one of these names changes, not on every snapshot update.
const botNamesAtom = Atom.family((botIdsKey: string) =>
  Atom.make((get) => {
    const names = new Map<string, string>();
    for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
      for (const bot of get(environmentBotsAtom(environmentId))) names.set(bot.id, bot.name);
    }
    return JSON.stringify(botIdsKey.split("\n").map((botId) => [botId, names.get(botId) ?? null]));
  }).pipe(Atom.withLabel(`mobile-bot-names:${botIdsKey}`)),
);

/** Names for the given bots, keyed by bot id. Bots the client cannot see are absent. */
export function useBotNames(botIds: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const key = botIds.join("\n");
  const json = useAtomValue(key === "" ? NO_BOT_NAMES_ATOM : botNamesAtom(key));
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const [botId, name] of JSON.parse(json) as Array<[string, string | null]>) {
      if (name !== null) names.set(botId, name);
    }
    return names;
  }, [json]);
}
