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

export function useRosterPendingApproval(threadRef: ScopedThreadRef | null) {
  const activities = useThreadActivities(threadRef);
  const pendingApprovals = useMemo(() => derivePendingApprovals(activities), [activities]);
  const respondToApproval = useAtomCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondingRef = useRef(false);
  const [responding, setResponding] = useState(false);
  const [responseError, setResponseError] = useState<string | null>(null);

  const respond = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision): Promise<boolean> => {
      if (!threadRef || respondingRef.current) return false;
      respondingRef.current = true;
      setResponding(true);
      setResponseError(null);
      try {
        const result = await respondToApproval({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, requestId, decision },
        });
        if (result._tag === "Failure") {
          const cause = squashAtomCommandFailure(result);
          setResponseError(cause instanceof Error ? cause.message : "Could not answer approval.");
          return false;
        }
        return true;
      } finally {
        respondingRef.current = false;
        setResponding(false);
      }
    },
    [respondToApproval, threadRef],
  );

  return {
    pendingApproval: pendingApprovals[0] ?? null,
    pendingCount: pendingApprovals.length,
    respond,
    responding,
    responseError,
  };
}
