export type DelegationSummaryOutcome =
  | { readonly _tag: "Completed"; readonly summary: string }
  | { readonly _tag: "Failed"; readonly message: string };

export interface DelegationSummaryTextInput {
  readonly botName: string;
  readonly task: string;
  readonly outcome: DelegationSummaryOutcome;
  /** Longest detail kept before the text is shortened. Defaults to 4,000. */
  readonly maxDetailChars?: number;
}

const DEFAULT_MAX_DETAIL_CHARS = 4_000;

/** Removes the markdown a channel would show literally, keeping the words. */
function plainText(value: string): string {
  return value
    .replace(/```[^\n]*\n?/g, "")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Plain-text line for finished bot work, used where no work card can render,
 * such as a chat that arrived from an external channel. Names the bot that
 * did the work.
 */
export function delegationSummaryText(input: DelegationSummaryTextInput): string {
  const maxDetailChars = input.maxDetailChars ?? DEFAULT_MAX_DETAIL_CHARS;
  const task = plainText(input.task).replace(/\s+/g, " ");
  const detail = plainText(
    input.outcome._tag === "Completed" ? input.outcome.summary : input.outcome.message,
  );
  const bounded =
    detail.length > maxDetailChars ? `${detail.slice(0, maxDetailChars).trimEnd()}…` : detail;
  const head =
    input.outcome._tag === "Completed"
      ? `${input.botName} finished "${task}"`
      : `${input.botName} could not finish "${task}"`;
  return bounded ? `${head}: ${bounded}` : `${head}.`;
}
