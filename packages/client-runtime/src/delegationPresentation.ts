import {
  akeruDelegationStateOf,
  isAkeruDelegationTerminal,
  isThreadWaitingOnChildren,
  type AkeruDelegationRecord,
  type AkeruDelegationState,
  type ThreadId,
} from "@t3tools/contracts";

/**
 * Whether the parent bot has received a finished result. Completed and failed
 * work is delivered once, to the parent's next turn or its CheckAgent call.
 * Canceled and unfinished work has no delivery state.
 */
export type DelegationDelivery = "pending" | "delivered";

export interface DelegationPresentation {
  readonly state: AkeruDelegationState;
  readonly terminal: boolean;
  readonly outcome:
    | { readonly kind: "result"; readonly text: string }
    | { readonly kind: "failure"; readonly text: string }
    | { readonly kind: "blocked"; readonly text: string }
    | null;
  readonly delivery: DelegationDelivery | null;
}

/** Card state shared by the web and mobile delegation views. */
export function presentDelegation(delegation: AkeruDelegationRecord): DelegationPresentation {
  const phase = delegation.phase;
  const state = akeruDelegationStateOf(phase);
  const delivery: DelegationDelivery | null =
    phase._tag === "Completed" || phase._tag === "Failed"
      ? phase.acknowledgedAt === null
        ? "pending"
        : "delivered"
      : null;
  return {
    state,
    terminal: isAkeruDelegationTerminal(phase),
    // Records written before the phase union can decode without details; the text is then empty.
    outcome:
      phase._tag === "Completed"
        ? { kind: "result", text: phase.result?.summary ?? "" }
        : phase._tag === "Failed"
          ? { kind: "failure", text: phase.failure?.message ?? "" }
          : phase._tag === "Blocked"
            ? { kind: "blocked", text: phase.reason }
            : null,
    delivery,
  };
}

/** Delegations a chat started, oldest first, and whether any are still working. */
export function threadDelegations(
  delegations: ReadonlyArray<AkeruDelegationRecord>,
  threadId: ThreadId,
): {
  readonly delegations: ReadonlyArray<AkeruDelegationRecord>;
  readonly waitingOnChildren: boolean;
} {
  return {
    delegations: delegations.filter((delegation) => delegation.parentThreadId === threadId),
    waitingOnChildren: isThreadWaitingOnChildren(delegations, threadId),
  };
}
