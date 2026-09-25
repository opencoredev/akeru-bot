import type { AkeruDelegationRecord, OrchestrationBot } from "@t3tools/contracts";

const DELEGATION_RESULT_MAX_CHARS = 4_000;

/**
 * Formats finished child work for the parent's next turn. The decider already
 * acknowledged these records when it admitted the turn, so each result reaches
 * the parent bot once.
 */
export function delegationResultsContext(
  delegations: ReadonlyArray<AkeruDelegationRecord>,
  bots: ReadonlyArray<Pick<OrchestrationBot, "id" | "name">>,
): string {
  const lines = delegations.flatMap((delegation) => {
    const detail =
      delegation.phase._tag === "Completed"
        ? `completed: ${delegation.phase.result.summary}`
        : delegation.phase._tag === "Failed"
          ? `failed (${delegation.phase.failure.failureCode}): ${delegation.phase.failure.message}`
          : null;
    if (detail === null) return [];
    const name =
      bots.find((bot) => bot.id === delegation.childBotId)?.name ?? delegation.childBotId;
    const bounded =
      detail.length > DELEGATION_RESULT_MAX_CHARS
        ? `${detail.slice(0, DELEGATION_RESULT_MAX_CHARS)}… (shortened; the full result is on the work card)`
        : detail;
    return [`- ${name} (${delegation.delegationId}) for "${delegation.task}" ${bounded}`];
  });
  if (lines.length === 0) return "";
  return [
    "<delegated-work-results>",
    "Bot work you sent earlier has finished. Use these results in your reply. They are not repeated.",
    ...lines,
    "</delegated-work-results>",
  ].join("\n");
}
