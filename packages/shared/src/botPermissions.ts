/**
 * The one permission policy for bot actions. Pure: callers supply the bot's
 * policy, the principal, the action, and the clock, and enforce the result.
 */
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";
import type {
  BotActionApprovalAnswer,
  BotActionApprovalBinding,
  BotActionFingerprint,
  BotActionPrincipal,
  BotActionRiskClass,
  BotApprovalGrantor,
  BotApprovalRejection,
  BotHumanPrincipal,
  BotOriginPrincipal,
  BotPermissionDecision,
  BotPermissionPolicy,
} from "@akeru/contracts";

const DECISION_RANK: Readonly<Record<BotPermissionDecision, number>> = {
  allow: 0,
  ask: 1,
  deny: 2,
};

/** The stricter of two decisions: deny beats ask, ask beats allow. */
export function strictestDecision(
  left: BotPermissionDecision,
  right: BotPermissionDecision,
): BotPermissionDecision {
  return DECISION_RANK[left] >= DECISION_RANK[right] ? left : right;
}

export interface BotActionRequest {
  /** The policy of the bot that would run the action. */
  readonly policy: BotPermissionPolicy;
  readonly principal: BotActionPrincipal;
  readonly action: {
    readonly toolId: string;
    readonly riskClass: BotActionRiskClass;
  };
}

export type BotPermissionVerdict =
  | { readonly decision: "allow" }
  | { readonly decision: "ask"; readonly answerer: BotHumanPrincipal }
  | { readonly decision: "deny"; readonly reason: "policy" | "not-allowlisted" };

/** The tool override when one exists, otherwise the risk-class default. */
export function botRuleForAction(
  policy: BotPermissionPolicy,
  action: BotActionRequest["action"],
): BotPermissionDecision {
  return Object.hasOwn(policy.toolOverrides, action.toolId)
    ? (policy.toolOverrides[action.toolId] ?? policy.defaults[action.riskClass])
    : policy.defaults[action.riskClass];
}

/** The origin a principal acts for. A bot request carries the person who started it. */
export function originOf(principal: BotActionPrincipal): BotOriginPrincipal {
  return principal.kind === "bot" ? principal.onBehalfOf : principal;
}

/** Only the owner answers approvals until channel identities exist. */
export function approverFor(_principal: BotActionPrincipal): BotHumanPrincipal {
  return { kind: "owner" };
}

/**
 * Decides allow, ask, or deny for one action. A bot acting for someone gets
 * exactly what that origin may do with the target bot, never more.
 */
export function decideBotAction(request: BotActionRequest): BotPermissionVerdict {
  const rule = botRuleForAction(request.policy, request.action);
  const origin = originOf(request.principal);
  let decision = rule;

  if (origin.kind === "person") {
    const person = request.policy.people.find((entry) => entry.personId === origin.personId);

    if (!person) return { decision: "deny", reason: "not-allowlisted" };
    decision = strictestDecision(rule, person.riskClasses[request.action.riskClass]);
  }

  switch (decision) {
    case "allow":
      return { decision: "allow" };
    case "ask":
      return { decision: "ask", answerer: approverFor(request.principal) };
    case "deny":
      return { decision: "deny", reason: "policy" };
    default: {
      const _exhaustive: never = decision;

      return _exhaustive;
    }
  }
}

/**
 * Canonical JSON for action arguments: sorted keys, undefined fields dropped.
 * Hash this to get a fingerprint's `argumentsDigest`.
 */
export function canonicalActionArguments<Value>(value: Value): string {
  if (Array.isArray(value)) return `[${value.map(canonicalActionArguments).join(",")}]`;

  if (Predicate.isObjectOrArray(value) && value !== null) {
    const entries = Object.keys(value)
      .map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value] as const)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalActionArguments(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "undefined";
}

/** Structural principal equality. */
export function samePrincipal(left: BotActionPrincipal, right: BotActionPrincipal): boolean {
  return canonicalActionArguments(left) === canonicalActionArguments(right);
}

export function sameAction(left: BotActionFingerprint, right: BotActionFingerprint): boolean {
  return left.toolId === right.toolId && left.argumentsDigest === right.argumentsDigest;
}

export interface OpenBotActionApprovalInput extends Omit<
  BotActionApprovalBinding,
  "answerer" | "openedAt" | "expiresAt"
> {
  readonly now: DateTime.Utc;
  readonly ttlMillis: number;
}

/** Binds an approval to its requester, answerer, exact action, environment, and expiry. */
export function openBotActionApproval(input: OpenBotActionApprovalInput): BotActionApprovalBinding {
  const { now, ttlMillis, ...binding } = input;

  return {
    ...binding,
    answerer: approverFor(input.requester),
    openedAt: DateTime.formatIso(now),
    expiresAt: DateTime.formatIso(DateTime.add(now, { milliseconds: ttlMillis })),
  };
}

export type BotApprovalCheck =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "Rejected"; readonly reason: BotApprovalRejection };

export const BotApprovalCheck = Data.taggedEnum<BotApprovalCheck>();

const accepted = BotApprovalCheck.Accepted();

const rejected = (reason: BotApprovalRejection): BotApprovalCheck =>
  BotApprovalCheck.Rejected({ reason });

const isExpired = (binding: BotActionApprovalBinding, now: DateTime.Utc) =>
  DateTime.isGreaterThanOrEqualTo(now, DateTime.makeUnsafe(binding.expiresAt));

/**
 * Checks one answer against its binding. `alreadyAnswered` is the caller's
 * record that this binding took an answer before, so each binding accepts one.
 */
export function checkBotApprovalAnswer(input: {
  readonly binding: BotActionApprovalBinding;
  readonly answer: BotActionApprovalAnswer;
  readonly alreadyAnswered: boolean;
  readonly now: DateTime.Utc;
}): BotApprovalCheck {
  if (input.answer.approvalId !== input.binding.approvalId) return rejected("unknown-approval");

  if (input.alreadyAnswered) return rejected("already-answered");

  if (isExpired(input.binding, input.now)) return rejected("expired");

  if (!samePrincipal(input.answer.answeredBy, input.binding.answerer)) {
    return rejected("wrong-principal");
  }

  return accepted;
}

/**
 * Re-checks an approved action right before it runs. The verdict must come
 * from the current policy, so a permission revoked after approval blocks it.
 */
export function authorizeApprovedBotAction(input: {
  readonly binding: BotActionApprovalBinding;
  readonly attempt: {
    readonly approvalId: BotActionApprovalBinding["approvalId"];
    readonly requester: BotActionPrincipal;
    readonly environmentId: BotActionApprovalBinding["environmentId"];
    readonly action: BotActionFingerprint;
  };
  readonly verdict: BotPermissionVerdict;
  readonly grantor: BotApprovalGrantor;
  readonly now: DateTime.Utc;
}): BotApprovalCheck {
  if (input.verdict.decision === "deny") return rejected("denied-by-policy");

  if (input.verdict.decision === "ask" && input.grantor !== "owner-answer") {
    return rejected("owner-approval-required");
  }

  if (input.attempt.approvalId !== input.binding.approvalId) return rejected("unknown-approval");

  if (isExpired(input.binding, input.now)) return rejected("expired");

  if (input.attempt.environmentId !== input.binding.environmentId) {
    return rejected("environment-mismatch");
  }

  if (!samePrincipal(input.attempt.requester, input.binding.requester)) {
    return rejected("requester-mismatch");
  }

  if (!sameAction(input.attempt.action, input.binding.action)) return rejected("action-mismatch");

  return accepted;
}
