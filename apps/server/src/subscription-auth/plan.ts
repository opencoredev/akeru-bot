import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
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

export const ClaudeProfile = Schema.Struct({
  account: Schema.optional(
    Schema.Struct({
      has_claude_max: Schema.optional(Schema.Unknown),
      has_claude_pro: Schema.optional(Schema.Unknown),
    }),
  ),
  organization: Schema.optional(
    Schema.Struct({
      organization_type: Schema.optional(Schema.Unknown),
      rate_limit_tier: Schema.optional(Schema.Unknown),
    }),
  ),
});

type ClaudeProfile = typeof ClaudeProfile.Type;

/** The Claude tier from the OAuth profile: Max 20x, Max 5x, Max, Pro, Team, or Enterprise. */
export function claudePlanLabel(profile: ClaudeProfile): string | undefined {
  const tier = profile.organization?.rate_limit_tier;

  if (Predicate.isString(tier)) {
    if (tier.includes("max_20x")) return "Max 20x";

    if (tier.includes("max_5x")) return "Max 5x";
  }

  switch (profile.organization?.organization_type) {
    case "claude_max":
      return "Max";
    case "claude_pro":
      return "Pro";
    case "claude_team":
      return "Team";
    case "claude_enterprise":
      return "Enterprise";
  }

  if (profile.account?.has_claude_max === true) return "Max";

  if (profile.account?.has_claude_pro === true) return "Pro";

  return undefined;
}
