// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off

import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
} from "@akeru/contracts";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import * as Ref from "effect/Ref";

import { type PendingApproval, type PendingUserInput } from "./CodexRuntimeState.ts";

export function createCodexRuntimeApprovals(deps: {
  readonly pendingApprovalsRef: Ref.Ref<Map<ApprovalRequestId, PendingApproval>>;
  readonly pendingUserInputsRef: Ref.Ref<Map<ApprovalRequestId, PendingUserInput>>;
}) {
  const settlePendingApprovals = (decision: ProviderApprovalDecision) =>
    Ref.get(deps.pendingApprovalsRef).pipe(
      Effect.flatMap((pendingApprovals) =>
        Effect.forEach(
          Array.from(pendingApprovals.values()),
          (pendingApproval) =>
            Deferred.succeed(pendingApproval.decision, decision).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    );
  const settlePendingUserInputs = (answers: ProviderUserInputAnswers) =>
    Ref.get(deps.pendingUserInputsRef).pipe(
      Effect.flatMap((pendingUserInputs) =>
        Effect.forEach(
          Array.from(pendingUserInputs.values()),
          (pendingUserInput) =>
            Deferred.succeed(pendingUserInput.answers, answers).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    );
  return { settlePendingApprovals, settlePendingUserInputs };
}
