import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import { derivePendingApprovals } from "../../session-logic";
import { useThreadActivities } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function rosterApprovalResponseKey(
  threadRef: ScopedThreadRef,
  requestId: ApprovalRequestId,
): string {
  return JSON.stringify([threadRef.environmentId, threadRef.threadId, requestId]);
}

export function useRosterPendingApproval(threadRef: ScopedThreadRef | null) {
  const activities = useThreadActivities(threadRef);
  const pendingApprovals = useMemo(() => derivePendingApprovals(activities), [activities]);
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondingRef = useRef(new Set<string>());
  const [responses, setResponses] = useState<
    ReadonlyMap<string, { readonly responding: boolean; readonly error: string | null }>
  >(() => new Map());

  const respond = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision): Promise<boolean> => {
      if (!threadRef) return false;
      const responseKey = rosterApprovalResponseKey(threadRef, requestId);
      if (respondingRef.current.has(responseKey)) return false;
      respondingRef.current.add(responseKey);
      setResponses((current) =>
        new Map(current).set(responseKey, { responding: true, error: null }),
      );
      let error: string | null = null;
      try {
        const result = await respondToApproval({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, requestId, decision },
        });
        if (result._tag === "Failure") {
          const cause = squashAtomCommandFailure(result);
          error = cause instanceof Error ? cause.message : "Could not answer approval.";
          return false;
        }
        return true;
      } finally {
        respondingRef.current.delete(responseKey);
        setResponses((current) => {
          const next = new Map(current);
          if (error) next.set(responseKey, { responding: false, error });
          else next.delete(responseKey);
          return next;
        });
      }
    },
    [respondToApproval, threadRef],
  );

  const pendingApproval = pendingApprovals[0] ?? null;
  const response =
    threadRef && pendingApproval
      ? responses.get(rosterApprovalResponseKey(threadRef, pendingApproval.requestId))
      : undefined;

  return {
    pendingApproval,
    pendingCount: pendingApprovals.length,
    respond,
    responding: response?.responding ?? false,
    responseError: response?.error ?? null,
  };
}
