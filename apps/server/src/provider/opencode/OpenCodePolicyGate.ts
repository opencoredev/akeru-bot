import {
  BOT_ACTION_RISK_CLASSES,
  DEFAULT_BOT_PERMISSION_POLICY,
  ProviderDriverKind,
  type BotPermissionPolicy,
  type RuntimeMode,
} from "@akeru/contracts";

const NATIVE_OPENCODE = ProviderDriverKind.make("opencode");

/**
 * Native OpenCode builds its permission rules from the runtime mode alone and
 * runs its own tools, so it cannot apply a bot policy. Returns why the turn must
 * not start when the policy is stricter than the default: any added `deny` or
 * `ask`. An `ask` is refused in every mode, because OpenCode can remember an
 * "always" grant for a command pattern, so a prompt is not a one-use owner
 * approval. The default policy keeps today's behavior. Other providers enforce
 * the policy for each call, so they are never refused here.
 */
export function openCodePolicyBlock(input: {
  readonly provider: ProviderDriverKind;
  readonly policy: BotPermissionPolicy;
  readonly runtimeMode: RuntimeMode;
}): string | undefined {
  const { policy } = input;

  if (input.provider !== NATIVE_OPENCODE) return undefined;

  const blockedClasses = BOT_ACTION_RISK_CLASSES.filter((riskClass) => {
    const decision = policy.defaults[riskClass];

    if (decision === DEFAULT_BOT_PERMISSION_POLICY.defaults[riskClass]) return false;

    return decision === "deny" || decision === "ask";
  });

  const blockedTools = Object.entries(policy.toolOverrides)
    .filter(([, decision]) => decision === "deny" || decision === "ask")
    .map(([toolName]) => toolName);

  if (blockedClasses.length === 0 && blockedTools.length === 0) return undefined;

  const rules = [
    ...blockedClasses.map((riskClass) => `${riskClass}: ${policy.defaults[riskClass]}`),
    ...blockedTools.map((toolName) => `${toolName}: ${policy.toolOverrides[toolName]}`),
  ].join(", ");

  return `This bot's permission policy (${rules}) can't be enforced on OpenCode, which only follows the chat's permission mode. Switch the bot to another provider, or relax those rules in the bot's permission policy.`;
}
