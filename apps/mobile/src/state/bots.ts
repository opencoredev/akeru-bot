import { createBotEnvironmentAtoms } from "@t3tools/client-runtime/state/bots";
import type { EnvironmentId, OrchestrationBot } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

const EMPTY_BOTS: ReadonlyArray<OrchestrationBot> = Object.freeze([]);

export const botEnvironment = createBotEnvironmentAtoms(connectionAtomRuntime);

export const environmentBotsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): ReadonlyArray<OrchestrationBot> =>
      get(environmentSnapshotAtom(environmentId))?.bots ?? EMPTY_BOTS,
  ).pipe(Atom.withLabel(`mobile-bots:${environmentId}`)),
);
