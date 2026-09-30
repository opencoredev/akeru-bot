import type { AkeruDelegationRecord, OrchestrationBot } from "@t3tools/contracts";
import { delegationSummaryText } from "@t3tools/shared/delegationSummaryText";

const DELEGATION_RESULT_MAX_CHARS = 4_000;

export interface DelegationResultsContextOptions {
  /**
   * The turn came from an external channel, where no work card renders. The
   * results are plain text that names each bot, ready to relay in the reply.
   */
  readonly channel?: boolean;
}

/**
 * Formats finished child work for the parent's next turn. The decider already
 * acknowledged these records when it admitted the turn, so each result reaches
 * the parent bot once.
 */
export function delegationResultsContext(
  delegations: ReadonlyArray<AkeruDelegationRecord>,
  bots: ReadonlyArray<Pick<OrchestrationBot, "id" | "name">>,
  options: DelegationResultsContextOptions = {},
): string {
  const lines = delegations.flatMap((delegation) => {
    const name =
      bots.find((bot) => bot.id === delegation.childBotId)?.name ?? delegation.childBotId;
    if (options.channel) {
      const outcome =
        delegation.phase._tag === "Completed"
          ? { _tag: "Completed" as const, summary: delegation.phase.result.summary }
          : delegation.phase._tag === "Failed"
            ? { _tag: "Failed" as const, message: delegation.phase.failure.message }
            : null;
      if (outcome === null) return [];
      return [
        `- ${delegationSummaryText({
          botName: name,
          task: delegation.task,
          outcome,
          maxDetailChars: DELEGATION_RESULT_MAX_CHARS,
        })}`,
      ];
    }
    const detail =
      delegation.phase._tag === "Completed"
        ? `completed: ${delegation.phase.result.summary}`
        : delegation.phase._tag === "Failed"
          ? `failed (${delegation.phase.failure.failureCode}): ${delegation.phase.failure.message}`
          : null;
    if (detail === null) return [];
    const bounded =
      detail.length > DELEGATION_RESULT_MAX_CHARS
        ? `${detail.slice(0, DELEGATION_RESULT_MAX_CHARS)}… (shortened; the full result is on the work card)`
        : detail;
    return [`- ${name} (${delegation.delegationId}) for "${delegation.task}" ${bounded}`];
  });
  if (lines.length === 0) return "";
  return [
    "<delegated-work-results>",
    options.channel
      ? "Bot work you sent earlier has finished. This chat is an external channel that shows only your reply text, so tell the sender what each bot found, in plain text without markdown. They are not repeated."
      : "Bot work you sent earlier has finished. Use these results in your reply. They are not repeated.",
    ...lines,
    "</delegated-work-results>",
  ].join("\n");
}
