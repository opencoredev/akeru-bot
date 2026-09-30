import { detectComposerTrigger } from "@akeru/shared/composerTrigger";

export interface BotPromptCommandTrigger {
  /** `skill` for a `$` token anywhere, `slash-command` for a `/` that starts a line. */
  readonly kind: "skill" | "slash-command";
  /** Text typed after `$` or `/`, used to rank the picker. */
  readonly query: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

/** The `$` skill or `/` command token being typed at the caret, or null when the picker stays closed. */
export function botPromptCommandTrigger(
  draft: string,
  caret: number,
): BotPromptCommandTrigger | null {
  const trigger = detectComposerTrigger(draft, caret);
  if (trigger?.kind !== "skill" && trigger?.kind !== "slash-command") return null;
  return {
    kind: trigger.kind,
    query: trigger.query,
    rangeStart: trigger.rangeStart,
    rangeEnd: trigger.rangeEnd,
  };
}

/**
 * Replaces the typed token with the picked `$skill ` or `/command ` text. A space right
 * after the token is absorbed so picking never leaves a double space.
 */
export function applyBotPromptCommand(
  draft: string,
  trigger: BotPromptCommandTrigger,
  inserted: string,
): { readonly text: string; readonly caret: number } {
  const before = draft.slice(0, trigger.rangeStart);
  const after = draft.slice(trigger.rangeEnd).replace(/^[ \t]/, "");
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}
