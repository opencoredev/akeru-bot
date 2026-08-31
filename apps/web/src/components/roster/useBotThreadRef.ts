import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useThreadShell, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { findLatestBotThreadTarget } from "./botThreadRuntime.logic";
import { parseChatPath } from "./roster.logic";
import { useRosterStore } from "./rosterStore";

export function useBotThreadRef(botId: string): ScopedThreadRef | null {
  const environmentId = usePrimaryEnvironmentId();
  const threadShells = useThreadShells();
  const rememberedPath = useRosterStore((state) => state.chatPathByBotId[botId]);
  const rememberedTarget = rememberedPath ? parseChatPath(rememberedPath) : null;
  const environmentThreads = useMemo(
    () =>
      environmentId ? threadShells.filter((thread) => thread.environmentId === environmentId) : [],
    [environmentId, threadShells],
  );
  const latestTarget = environmentId
    ? findLatestBotThreadTarget(botId, environmentId, environmentThreads)
    : null;
  const candidate = useMemo<ScopedThreadRef | null>(() => {
    const target =
      (rememberedTarget?.kind === "thread" && rememberedTarget.environmentId === environmentId
        ? rememberedTarget
        : null) ?? latestTarget;
    return target
      ? scopeThreadRef(EnvironmentId.make(target.environmentId), ThreadId.make(target.threadId))
      : null;
  }, [environmentId, latestTarget, rememberedTarget]);
  return useThreadShell(candidate) ? candidate : null;
}
