import * as Predicate from "effect/Predicate";
/**
 * Subscription tiers as people know them ("Pro", "Max 20x"), read from what
 * each provider reports at sign-in. Unknown values stay unknown rather than guessed.
 */

const CODEX_PLANS = new Map([
  ["free", "Free"],
  ["plus", "Plus"],
  ["pro", "Pro"],
  ["prolite", "Pro Lite"],
  ["team", "Team"],
  ["business", "Business"],
  ["enterprise", "Enterprise"],
  ["edu", "Edu"],
]);

/** The ChatGPT tier from a Codex token's `chatgpt_plan_type` claim. */
export function codexPlanLabel(value: string | undefined): string | undefined {
  return Predicate.isString(value) ? CODEX_PLANS.get(value.toLowerCase()) : undefined;
}
