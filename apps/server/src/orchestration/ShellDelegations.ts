import type { AkeruDelegationRecord } from "@t3tools/contracts";

/**
 * Terminal delegations (completed, failed, canceled) the shell snapshot keeps
 * per parent thread, newest first. Open ones are always kept.
 */
export const SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD = 20;
/** Longest delegation result summary or failure message the shell snapshot carries. */
export const SHELL_DELEGATION_TEXT_MAX_CHARS = 2_000;

function truncateShellText(text: string): string {
  return text.length <= SHELL_DELEGATION_TEXT_MAX_CHARS
    ? text
    : `${text.slice(0, SHELL_DELEGATION_TEXT_MAX_CHARS - 1).trimEnd()}…`;
}

/** Caps a delegation's free-form result text for shell payloads. */
export function toShellDelegation(delegation: AkeruDelegationRecord): AkeruDelegationRecord {
  const summary = delegation.result?.summary;
  const message = delegation.failure?.message;
  const summaryFits = summary === undefined || summary.length <= SHELL_DELEGATION_TEXT_MAX_CHARS;
  const messageFits = message === undefined || message.length <= SHELL_DELEGATION_TEXT_MAX_CHARS;
  if (summaryFits && messageFits) return delegation;
  return {
    ...delegation,
    result:
      delegation.result === null || summaryFits
        ? delegation.result
        : { ...delegation.result, summary: truncateShellText(delegation.result.summary) },
    failure:
      delegation.failure === null || messageFits
        ? delegation.failure
        : { ...delegation.failure, message: truncateShellText(delegation.failure.message) },
  };
}
