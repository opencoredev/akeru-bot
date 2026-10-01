import * as Match from "effect/Match";
import type { AkeruDelegationRecord } from "@akeru/contracts";

export { SHELL_RECENT_TERMINAL_DELEGATIONS_PER_THREAD } from "@akeru/contracts";

/** Longest delegation result summary or failure message the shell snapshot carries. */
export const SHELL_DELEGATION_TEXT_MAX_CHARS = 2_000;

function truncateShellText(text: string): string {
  return text.length <= SHELL_DELEGATION_TEXT_MAX_CHARS
    ? text
    : `${text.slice(0, SHELL_DELEGATION_TEXT_MAX_CHARS - 1).trimEnd()}…`;
}

/** Caps a delegation's free-form result, failure, or blocked text for shell payloads. */
export function toShellDelegation(delegation: AkeruDelegationRecord): AkeruDelegationRecord {
  const phase = delegation.phase;

  return Match.value(phase).pipe(
    Match.tag("Completed", (phase) => {
      return phase.result.summary.length <= SHELL_DELEGATION_TEXT_MAX_CHARS
        ? delegation
        : {
            ...delegation,
            phase: {
              ...phase,
              result: { ...phase.result, summary: truncateShellText(phase.result.summary) },
            },
          };
    }),
    Match.tag("Failed", (phase) => {
      return phase.failure.message.length <= SHELL_DELEGATION_TEXT_MAX_CHARS
        ? delegation
        : {
            ...delegation,
            phase: {
              ...phase,
              failure: { ...phase.failure, message: truncateShellText(phase.failure.message) },
            },
          };
    }),
    Match.tag("Blocked", (phase) => {
      return phase.reason.length <= SHELL_DELEGATION_TEXT_MAX_CHARS
        ? delegation
        : { ...delegation, phase: { ...phase, reason: truncateShellText(phase.reason) } };
    }),
    Match.orElse(() => delegation),
  );
}
