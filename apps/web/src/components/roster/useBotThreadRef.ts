import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShell, useThreadShells } from "../../state/entities";
import { findLatestBotThreadTarget } from "./botThreadRuntime.logic";
import { parseChatPath } from "./roster.logic";
import { useRosterStore } from "./rosterStore";

export function useBotThreadRef(botId: string): ScopedThreadRef | null {
  const environmentId = usePrimaryEnvironmentId();
  const threads = useThreadShells();
  const rememberedPath = useRosterStore((state) => state.chatPathByBotId[botId]);
  const target = rememberedPath ? parseChatPath(rememberedPath) : null;
  const candidate = environmentId
    ? (findLatestBotThreadTarget(botId, environmentId, threads) ??
      (target?.kind === "thread" && target.environmentId === environmentId ? target : null))
    : null;
  const ref = useMemo(
    () =>
      candidate
        ? scopeThreadRef(
            EnvironmentId.make(candidate.environmentId),
            ThreadId.make(candidate.threadId),
          )
        : null,
    [candidate?.environmentId, candidate?.threadId],
  );
  return useThreadShell(ref) ? ref : null;
}
