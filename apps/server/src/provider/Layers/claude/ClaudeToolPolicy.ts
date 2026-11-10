/**
 * The bot permission policy for Claude Code tool calls. Claude Code runs its
 * own tools, so the adapter asks the policy before each call and again right
 * before an approved call runs. See docs/internals/permissions.md.
 *
 * @module provider/Layers/claude/ClaudeToolPolicy
 */
import {
  BotApprovalId,
  type BotActionApprovalBinding,
  type BotActionPrincipal,
  type BotActionRiskClass,
  type BotId,
  type ThreadId,
} from "@akeru/contracts";
import { claudeCodeToolRiskClass } from "@akeru/shared/botActionRisk";
import {
  authorizeApprovedBotAction,
  decideBotAction,
  openBotActionApproval,
  type BotApprovalCheck,
  type BotPermissionVerdict,
} from "@akeru/shared/botPermissions";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  DEFAULT_APPROVAL_TTL_MILLIS,
  LOCAL_ENVIRONMENT_ID,
  OWNER_PRINCIPAL,
  actionFingerprint,
} from "../../tools/AkeruToolPermissions.ts";
import { type BotToolPermissionSession } from "../../tools/BotToolPermissionSessions.ts";
import {
  claudeCodeToolPathReach,
  type ClaudeCodeFileScope,
} from "../../claudeCode/ClaudeCodeToolPaths.ts";
import type { SdkRecord } from "../ProtocolJson.ts";

export interface ClaudeToolPolicyDecision {
  readonly verdict: BotPermissionVerdict;
  readonly riskClass: BotActionRiskClass;
  readonly principal: BotActionPrincipal;
  readonly botId: BotId | null;
  /** The call names a path in Claude Code's own login or settings, which bots may not use. */
  readonly touchesClaudeConfig: boolean;
  /** A shell command that may reach them; the owner answers it whatever the policy allows. */
  readonly mayTouchClaudeConfig: boolean;
}

const DENIED_BY_POLICY: BotPermissionVerdict = { decision: "deny", reason: "policy" };

/**
 * Decides one call from the policy as it is now. A missing policy entry, or a
 * policy that cannot be read, denies the call rather than letting it through.
 */
export const decideClaudeToolCall = Effect.fn("decideClaudeToolCall")(function* (
  session: BotToolPermissionSession | undefined,
  toolName: string,
  toolInput: SdkRecord,
  fileScope: ClaudeCodeFileScope,
) {
  const principal = session?.permissions.principal ?? OWNER_PRINCIPAL;
  const readPolicy = session?.permissions.readPolicy;
  const reach = yield* claudeCodeToolPathReach(toolName, toolInput, fileScope);

  const mayTouchClaudeConfig = reach === "claude-config-shell";

  const riskClass = mayTouchClaudeConfig
    ? "write-outside"
    : claudeCodeToolRiskClass(toolName, toolInput, reach === "outside" ? "outside" : "inside");

  if (reach === "claude-config") {
    return {
      verdict: DENIED_BY_POLICY,
      riskClass: "write-outside",
      principal,
      botId: session?.botId ?? null,
      touchesClaudeConfig: true,
      mayTouchClaudeConfig: false,
    } satisfies ClaudeToolPolicyDecision;
  }

  const policy = !session
    ? Option.none()
    : readPolicy
      ? yield* Effect.tryPromise(readPolicy).pipe(Effect.option)
      : Option.some(session.permissions.policy);

  const policyVerdict = Option.match(policy, {
    onNone: () => DENIED_BY_POLICY,
    onSome: (current) =>
      decideBotAction({ policy: current, principal, action: { toolId: toolName, riskClass } }),
  });

  // The shell check is a guess, so the owner sees every such command; a policy deny still wins.
  const verdict: BotPermissionVerdict =
    mayTouchClaudeConfig && policyVerdict.decision === "allow"
      ? { decision: "ask", answerer: OWNER_PRINCIPAL }
      : policyVerdict;

  return {
    verdict,
    riskClass,
    principal,
    botId: session?.botId ?? null,
    touchesClaudeConfig: false,
    mayTouchClaudeConfig,
  } satisfies ClaudeToolPolicyDecision;
});

/** Binds an owner approval to this exact call, so a different call cannot reuse it. */
export const openClaudeToolApproval = Effect.fn("openClaudeToolApproval")(function* (input: {
  readonly threadId: ThreadId;
  readonly toolUseId: string;
  readonly toolName: string;
  readonly toolInput: SdkRecord;
  readonly decision: ClaudeToolPolicyDecision;
}) {
  return openBotActionApproval({
    approvalId: BotApprovalId.make(input.toolUseId),
    botId: input.decision.botId,
    threadId: input.threadId,
    environmentId: LOCAL_ENVIRONMENT_ID,
    requester: input.decision.principal,
    action: actionFingerprint(input.toolName, input.toolInput),
    riskClass: input.decision.riskClass,
    now: yield* DateTime.now,
    ttlMillis: DEFAULT_APPROVAL_TTL_MILLIS,
  });
});

/**
 * Re-reads the policy right before an approved call runs. A permission revoked
 * while the approval waited, or an expired approval, blocks the run.
 */
export const recheckClaudeToolApproval = Effect.fn("recheckClaudeToolApproval")(function* (input: {
  readonly permissions: BotToolPermissionSession | undefined;
  readonly binding: BotActionApprovalBinding;
  readonly toolName: string;
  readonly toolInput: SdkRecord;
  readonly fileScope: ClaudeCodeFileScope;
}) {
  const current = yield* decideClaudeToolCall(
    input.permissions,
    input.toolName,
    input.toolInput,
    input.fileScope,
  );

  return authorizeApprovedBotAction({
    binding: input.binding,
    attempt: {
      approvalId: input.binding.approvalId,
      requester: current.principal,
      environmentId: input.binding.environmentId,
      action: actionFingerprint(input.toolName, input.toolInput),
    },
    verdict: current.verdict,
    grantor: "owner-answer",
    now: yield* DateTime.now,
  }) satisfies BotApprovalCheck;
});

export function claudeToolPolicyDeniedMessage(
  toolName: string,
  decision?: Pick<ClaudeToolPolicyDecision, "touchesClaudeConfig">,
): string {
  return decision?.touchesClaudeConfig
    ? `Tool '${toolName}' would touch Claude Code's own login or settings, which bots may not read or change.`
    : `Tool '${toolName}' is not allowed by this bot's permission policy.`;
}

const RISK_REASONS: Readonly<Record<BotActionRiskClass, string>> = {
  read: "it reads files in the bot's workspace",
  "write-workspace": "it changes files in the bot's workspace",
  "environment-access": "it uses your computer outside the bot's workspace",
  "write-outside": "it can change things outside the bot's workspace",
};

/** Why the policy asks the owner, in words the approval card can show. */
export function claudeToolAskReason(
  decision: Pick<ClaudeToolPolicyDecision, "riskClass" | "mayTouchClaudeConfig">,
): string {
  return decision.mayTouchClaudeConfig
    ? "This command may read or change Claude Code's own login or settings. Akeru always asks you before such a command, whatever the bot's policy allows."
    : `This bot's permission policy asks you first because ${RISK_REASONS[decision.riskClass]}.`;
}

export function claudeToolApprovalRejectedMessage(toolName: string, reason: string): string {
  return `Tool '${toolName}' was approved, but the approval no longer holds (${reason}). Ask again if you still need it.`;
}
