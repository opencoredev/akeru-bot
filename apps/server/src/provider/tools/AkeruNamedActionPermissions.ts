import type { BotHumanPrincipal, BotPermissionPolicy } from "@akeru/contracts";
import { namedActionRiskClass } from "@akeru/shared/botActionRisk";
import { BotApprovalCheck, decideBotAction } from "@akeru/shared/botPermissions";

import {
  AkeruToolPermissionDeniedError,
  OWNER_PRINCIPAL,
  actionFingerprint,
  initialPolicy,
  principalOf,
  type createAkeruApprovalLedger,
} from "./AkeruToolPermissions.ts";
import type { AkeruToolSession } from "./AkeruToolTypes.ts";

/** One call to a named action outside the tool catalog, such as routine listing. */
export interface AkeruNamedActionCall<Input> {
  readonly threadId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Input;
}

/**
 * The permission decision, approval binding, and run-time re-check for named
 * actions. They share the catalog tools' ledger, so the same answer rules apply.
 */
export function createAkeruNamedActionPermissions(deps: {
  readonly sessions: ReadonlyMap<string, AkeruToolSession>;
  readonly policies: ReadonlyMap<string, BotPermissionPolicy>;
  readonly approvals: ReturnType<typeof createAkeruApprovalLedger>;
  readonly currentPolicy: (
    threadId: string,
    session: AkeruToolSession,
  ) => Promise<BotPermissionPolicy>;
}) {
  const sessionFor = (threadId: string) => {
    const session = deps.sessions.get(threadId);

    if (!session) throw new Error(`Tool session '${threadId}' is not registered.`);

    return session;
  };

  const decide = <Input>(
    session: AkeruToolSession,
    policy: BotPermissionPolicy,
    toolName: string,
    input: Input,
  ) => {
    const riskClass = namedActionRiskClass(toolName, input);

    const verdict = decideBotAction({
      policy,
      principal: principalOf(session),
      action: { toolId: toolName, riskClass },
    });

    if (verdict.decision === "deny") throw new AkeruToolPermissionDeniedError(toolName);

    return { verdict, riskClass };
  };

  const subject = <Input>(call: AkeruNamedActionCall<Input>, session: AkeruToolSession) => ({
    threadId: call.threadId,
    toolCallId: call.toolCallId,
    session,
    action: actionFingerprint(call.toolName, call.input),
    riskClass: namedActionRiskClass(call.toolName, call.input),
  });

  return {
    /** Reads the current policy. Deny throws; true means the owner must answer first. */
    requiresNamedApproval: async <Input>(threadId: string, toolName: string, input: Input) => {
      const session = sessionFor(threadId);

      const { verdict } = decide(
        session,
        await deps.currentPolicy(threadId, session),
        toolName,
        input,
      );

      return verdict.decision === "ask";
    },
    /** Whether the owner must answer, from the last policy this thread read. */
    namedActionRequirement: <Input>(
      threadId: string,
      toolName: string,
      input: Input,
    ): "none" | "owner" | "blocked" => {
      try {
        const session = sessionFor(threadId);
        const policy = deps.policies.get(threadId) ?? initialPolicy(session);

        return decide(session, policy, toolName, input).verdict.decision === "ask"
          ? "owner"
          : "none";
      } catch {
        // The run repeats the check and reports the failure to the bot.
        return "blocked";
      }
    },
    openNamedApproval: <Input>(call: AkeruNamedActionCall<Input>) => {
      const session = deps.sessions.get(call.threadId);

      if (session) deps.approvals.open(subject(call, session));
    },
    grantNamedApproval: <Input>(
      call: AkeruNamedActionCall<Input> & { readonly answeredBy?: BotHumanPrincipal },
    ): BotApprovalCheck => {
      const session = deps.sessions.get(call.threadId);

      if (!session) return BotApprovalCheck.Rejected({ reason: "unknown-approval" });

      return deps.approvals.answer({
        ...subject(call, session),
        answeredBy: call.answeredBy ?? OWNER_PRINCIPAL,
      });
    },
    /**
     * Re-reads the policy right before the action runs. Deny throws; an owner
     * ask spends the owner's grant for this exact call or throws without one.
     */
    authorizeNamedExecution: async <Input>(call: AkeruNamedActionCall<Input>) => {
      const session = sessionFor(call.threadId);

      const { verdict } = decide(
        session,
        await deps.currentPolicy(call.threadId, session),
        call.toolName,
        call.input,
      );

      if (verdict.decision !== "ask") return;

      const rejection = deps.approvals.consume({
        threadId: call.threadId,
        toolCallId: call.toolCallId,
        session,
        action: actionFingerprint(call.toolName, call.input),
        verdict,
      });

      if (rejection === "not-approved") {
        throw new Error(`Tool '${call.toolName}' requires approval.`);
      }

      if (rejection) {
        throw new Error(`Tool '${call.toolName}' approval was refused (${rejection}).`);
      }
    },
    /** Checks routine changes whose own review or question carries the owner's answer. */
    authorizeAction: async <Input>(threadId: string, toolName: string, input: Input) => {
      const session = sessionFor(threadId);
      decide(session, await deps.currentPolicy(threadId, session), toolName, input);
    },
  };
}
