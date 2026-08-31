import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useThreadShell, useThreadShells } from "../../state/entities";
import { findLatestBotThreadTarget } from "./botThreadRuntime.logic";
import { parseChatPath } from "./roster.logic";
import { useRosterStore } from "./rosterStore";

export function resolveBotThreadTarget(
  botId: string,
  environmentId: string,
  threads: Parameters<typeof findLatestBotThreadTarget>[2],
  rememberedPath: string | undefined,
) {
  const remembered = rememberedPath ? parseChatPath(rememberedPath) : null;
  if (
    remembered?.kind === "thread" &&
    remembered.environmentId === environmentId &&
    threads.some(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.id === remembered.threadId &&
        thread.botId === botId &&
        thread.archivedAt === null &&
        thread.deletedAt == null,
    )
  ) {
    return remembered;
  }
  return findLatestBotThreadTarget(botId, environmentId, threads);
}

export function useBotThreadRef(botId: string): ScopedThreadRef | null {
  const environmentId = usePrimaryEnvironmentId();
  const threads = useThreadShells();
  const rememberedPath = useRosterStore((state) => state.chatPathByBotId[botId]);
  const candidate = environmentId
    ? resolveBotThreadTarget(botId, environmentId, threads, rememberedPath)
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
