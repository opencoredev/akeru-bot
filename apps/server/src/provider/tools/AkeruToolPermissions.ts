import * as NodeCrypto from "node:crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";
import {
  AKERU_TOOL_CATALOG,
  BotActionArgumentsDigest,
  BotApprovalId,
  DEFAULT_BOT_PERMISSION_POLICY,
  EnvironmentId,
  ThreadId,
  akeruToolApprovalForInput,
  akeruToolModeRequiresApproval,
  type BotActionApprovalBinding,
  type BotActionFingerprint,
  type BotActionPrincipal,
  type BotActionRiskClass,
  type BotApprovalGrantor,
  type BotApprovalRejection,
  type BotHumanPrincipal,
  type BotPermissionPolicy,
} from "@akeru/contracts";
import {
  BotApprovalCheck,
  authorizeApprovedBotAction,
  canonicalActionArguments,
  checkBotApprovalAnswer,
  decideBotAction,
  openBotActionApproval,
  type BotPermissionVerdict,
} from "@akeru/shared/botPermissions";
import { akeruToolRiskClassForInput } from "@akeru/shared/botActionRisk";

import { APPROVAL_RANK, ensureWorkspaceCwd } from "./AkeruToolAuthorization.ts";
import type { AkeruRuntimeToolId, AkeruToolSession } from "./AkeruToolTypes.ts";

/** Pending approvals wait this long for an answer and the approved run. */
export const DEFAULT_APPROVAL_TTL_MILLIS = 24 * 60 * 60 * 1000;

/** Used when the server has no persisted environment id, such as in unit tests. */
export const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("local");

export const OWNER_PRINCIPAL = { kind: "owner" } as const satisfies BotHumanPrincipal;

/**
 * Who must approve a call. `mode` approvals may be answered by the chat's
 * permission mode; `owner` approvals come from the bot policy and need a person.
 */
export type AkeruApprovalRequirement = "none" | "mode" | "owner";

export interface AkeruToolDecision {
  readonly requirement: AkeruApprovalRequirement;
  readonly verdict: BotPermissionVerdict;
  readonly riskClass: BotActionRiskClass;
}

export class AkeruToolPermissionDeniedError extends Error {
  constructor(toolId: string) {
    super(`Tool '${toolId}' is not allowed by this bot's permission policy.`);
  }
}

export function principalOf(session: AkeruToolSession): BotActionPrincipal {
  return session.permissions?.principal ?? OWNER_PRINCIPAL;
}

export function actionFingerprint<Input>(
  toolId: string,
  decodedInput: Input,
): BotActionFingerprint {
  return {
    toolId,
    argumentsDigest: BotActionArgumentsDigest.make(
      NodeCrypto.createHash("sha256").update(canonicalActionArguments(decodedInput)).digest("hex"),
    ),
  };
}

/** The risk class of one call. Memory writes stay in the bot's own workspace. */
export function akeruRiskClass<Input>(
  session: AkeruToolSession,
  toolId: AkeruRuntimeToolId,
  decodedInput: Input,
): BotActionRiskClass {
  if (toolId === "memory") return "write-workspace";
  const akeruTool = AKERU_TOOL_CATALOG.find((candidate) => candidate.id === toolId);

  return akeruTool
    ? akeruToolRiskClassForInput(akeruTool, decodedInput, { workspaceType: session.workspaceType })
    : "write-outside";
}

/**
 * The bot policy and the chat mode together decide one call. Deny throws, so a
 * blocked call never reaches a prompt or a backend.
 */
export function decideAkeruTool<Input>(input: {
  readonly session: AkeruToolSession;
  readonly policy: BotPermissionPolicy;
  readonly toolId: AkeruRuntimeToolId;
  readonly decodedInput: Input;
}): AkeruToolDecision {
  const { session, toolId, decodedInput } = input;
  let riskClass: BotActionRiskClass = "write-workspace";
  let modeAsks = false;

  if (toolId !== "memory") {
    const akeruTool = AKERU_TOOL_CATALOG.find((candidate) => candidate.id === toolId);

    if (!akeruTool) throw new Error(`Tool '${toolId}' has no definition.`);
    ensureWorkspaceCwd(akeruTool.id, decodedInput);
    const context = { workspaceType: session.workspaceType };
    const ceiling = session.delegation?.access.approvalCeiling;

    if (
      ceiling &&
      APPROVAL_RANK.indexOf(akeruToolApprovalForInput(akeruTool, decodedInput, context)) >
        APPROVAL_RANK.indexOf(ceiling)
    ) {
      throw new Error(`Tool '${toolId}' exceeds this delegation's approval ceiling.`);
    }

    riskClass = akeruToolRiskClassForInput(akeruTool, decodedInput, context);
    modeAsks = akeruToolModeRequiresApproval(
      akeruTool,
      { ...context, localFullAccess: session.runtimeMode === "full-access" },
      decodedInput,
    );
  }

  const verdict = decideBotAction({
    policy: input.policy,
    principal: principalOf(session),
    action: { toolId, riskClass },
  });

  if (verdict.decision === "deny") throw new AkeruToolPermissionDeniedError(toolId);

  return {
    verdict,
    riskClass,
    requirement: verdict.decision === "ask" ? "owner" : modeAsks ? "mode" : "none",
  };
}

/**
 * One binding's lifecycle. `consumed` stays as a tombstone until the thread's
 * approvals are cleared, so a spent approval can never be answered again.
 */
type ApprovalState =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Granted"; readonly grantor: BotApprovalGrantor }
  | { readonly _tag: "Consumed" };

interface ApprovalEntry {
  readonly binding: BotActionApprovalBinding;
  state: ApprovalState;
}

const ApprovalState = Data.taggedEnum<ApprovalState>();

const rejectedCheck = (reason: BotApprovalRejection) => BotApprovalCheck.Rejected({ reason });

interface ApprovalSubject {
  readonly threadId: string;
  readonly toolCallId: string;
  readonly session: AkeruToolSession;
  readonly action: BotActionFingerprint;
  readonly riskClass: BotActionRiskClass;
}

/**
 * Approvals keyed by thread, tool call, and argument digest. A binding must be
 * opened before it can be answered, takes one grant, and covers one run.
 */
export function createAkeruApprovalLedger(options: {
  readonly environmentId: EnvironmentId;
  readonly ttlMillis: number;
  readonly clock: () => DateTime.Utc;
}) {
  const entries = new Map<string, ApprovalEntry>();

  const key = (threadId: string, toolCallId: string, action: BotActionFingerprint) =>
    `${threadId}\u0000${toolCallId}\u0000${action.toolId}\u0000${action.argumentsDigest}`;

  const entryFor = (input: Pick<ApprovalSubject, "threadId" | "toolCallId" | "action">) =>
    entries.get(key(input.threadId, input.toolCallId, input.action));

  /** Grants an open binding. Every other state refuses the grant. */
  const grant = (
    input: ApprovalSubject,
    grantor: BotApprovalGrantor,
    check: (entry: ApprovalEntry, now: DateTime.Utc) => BotApprovalCheck,
  ): BotApprovalCheck => {
    const entry = entryFor(input);

    if (!entry) return rejectedCheck("unknown-approval");

    if (!Predicate.isTagged(entry.state, "Open")) return rejectedCheck("already-answered");
    const result = check(entry, options.clock());

    if (Predicate.isTagged(result, "Accepted")) entry.state = ApprovalState.Granted({ grantor });

    return result;
  };

  return {
    /** Opens the binding for a pending approval, or leaves an existing one as it is. */
    open: (input: ApprovalSubject) => {
      const entryKey = key(input.threadId, input.toolCallId, input.action);

      if (entries.has(entryKey)) return;

      entries.set(entryKey, {
        state: ApprovalState.Open(),
        binding: openBotActionApproval({
          approvalId: BotApprovalId.make(input.toolCallId),
          botId: input.session.botId ?? null,
          threadId: ThreadId.make(input.threadId),
          environmentId: options.environmentId,
          requester: principalOf(input.session),
          action: input.action,
          riskClass: input.riskClass,
          now: options.clock(),
          ttlMillis: options.ttlMillis,
        }),
      });
    },
    /** Records the owner's answer. A replayed, expired, unopened, or misaddressed answer is refused. */
    answer: (input: ApprovalSubject & { readonly answeredBy: BotHumanPrincipal }) =>
      grant(input, "owner-answer", (entry, now) =>
        checkBotApprovalAnswer({
          binding: entry.binding,
          answer: {
            approvalId: entry.binding.approvalId,
            answeredBy: input.answeredBy,
            decision: "approve",
            answeredAt: DateTime.formatIso(now),
          },
          alreadyAnswered: false,
          now,
        }),
      ),
    /**
     * Records the chat mode approving a routine call. The caller passes the
     * current requirement; an approval the policy reserves for the owner is refused.
     */
    grantByMode: (input: ApprovalSubject & { readonly requirement: AkeruApprovalRequirement }) =>
      grant(input, "permission-mode", (entry, now) => {
        if (input.requirement === "owner") return rejectedCheck("owner-approval-required");

        return DateTime.isGreaterThanOrEqualTo(now, DateTime.makeUnsafe(entry.binding.expiresAt))
          ? rejectedCheck("expired")
          : BotApprovalCheck.Accepted();
      }),
    /**
     * Spends the grant for one run after re-checking the current verdict.
     * Returns the rejection, or undefined when the run may proceed.
     */
    consume: (input: {
      readonly threadId: string;
      readonly toolCallId: string;
      readonly session: AkeruToolSession;
      readonly action: BotActionFingerprint;
      readonly verdict: BotPermissionVerdict;
    }): BotApprovalRejection | undefined => {
      const entry = entryFor(input);

      if (!entry || !Predicate.isTagged(entry.state, "Granted")) return "not-approved";
      const grantor = entry.state.grantor;
      entry.state = ApprovalState.Consumed();

      const check = authorizeApprovedBotAction({
        binding: entry.binding,
        attempt: {
          approvalId: BotApprovalId.make(input.toolCallId),
          requester: principalOf(input.session),
          environmentId: options.environmentId,
          action: input.action,
        },
        verdict: input.verdict,
        grantor,
        now: options.clock(),
      });

      return Predicate.isTagged(check, "Rejected") ? check.reason : undefined;
    },
    clearThread: (threadId: string) => {
      for (const entryKey of entries.keys()) {
        if (entryKey.startsWith(`${threadId}\u0000`)) entries.delete(entryKey);
      }
    },
  };
}

export function initialPolicy(session: AkeruToolSession): BotPermissionPolicy {
  return session.permissions?.policy ?? DEFAULT_BOT_PERMISSION_POLICY;
}
