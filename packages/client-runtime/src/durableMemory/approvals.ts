import {
  AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY,
  AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY,
  AkeruMemoryApprovalRequest,
  AkeruMemoryDecisionReceipt,
  type AkeruMemoryMutation,
  type AkeruMemoryTargetScope,
} from "@akeru/contracts";
import * as Schema from "effect/Schema";
import { type MessageKey } from "../i18n/index.ts";
import { type DurableMemoryTranslator, englishTranslator } from "./types.ts";

/** Approval card heading for each scope a pending fact would be saved to. */
export const MEMORY_APPROVAL_HEADINGS: Readonly<Record<AkeruMemoryTargetScope, MessageKey>> = {
  private: "Save to private memory?",
  bot: "Save to this bot's memory?",
  project: "Save to project memory?",
  group: "Save to group memory?",
  workspace: "Save to workspace memory?",
};

/** Inbox next-step line for each scope a pending fact would be saved to. */
export const MEMORY_APPROVAL_ACTIONS: Readonly<Record<AkeruMemoryTargetScope, MessageKey>> = {
  private: "Save to private memory",
  bot: "Save to this bot's memory",
  project: "Save to project memory",
  group: "Save to group memory",
  workspace: "Save to workspace memory",
};

export const memoryApprovalHeading = (
  scope: AkeruMemoryTargetScope,
  i18n: Pick<DurableMemoryTranslator, "t"> = englishTranslator,
) => i18n.t(MEMORY_APPROVAL_HEADINGS[scope]);

const isApprovalRequest = Schema.is(AkeruMemoryApprovalRequest);

const isDecisionReceipt = Schema.is(AkeruMemoryDecisionReceipt);

/**
 * Shared facts a bot asked to save in this chat that nobody has approved or
 * rejected yet, oldest first. Derived from thread activities, so the list
 * survives reloads and clears when either the chat card or the inbox decides.
 */
export function pendingMemoryApprovals(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): ReadonlyArray<AkeruMemoryApprovalRequest> {
  const resolved = new Set<string>();

  for (const activity of activities) {
    if (
      activity.kind === AKERU_MEMORY_APPROVAL_RESOLVED_ACTIVITY &&
      isDecisionReceipt(activity.payload)
    ) {
      resolved.add(activity.payload.candidateId);
    }
  }

  const pending: AkeruMemoryApprovalRequest[] = [];
  const seen = new Set<string>();

  for (const activity of activities) {
    if (
      activity.kind !== AKERU_MEMORY_APPROVAL_REQUESTED_ACTIVITY ||
      !isApprovalRequest(activity.payload)
    ) {
      continue;
    }

    const request = activity.payload;

    if (resolved.has(request.candidateId) || seen.has(request.candidateId)) continue;
    seen.add(request.candidateId);
    pending.push(request);
  }

  return pending;
}

export type MemoryApprovalIntent =
  | { readonly action: "approve"; readonly fact?: string }
  | { readonly action: "reject" };

/** Builds the mutation that approves, edits and approves, or rejects a pending shared fact. */
export function memoryApprovalMutation(
  request: Pick<AkeruMemoryApprovalRequest, "candidateId" | "fact">,
  intent: MemoryApprovalIntent,
): AkeruMemoryMutation {
  if (intent.action === "reject") {
    return {
      operation: "candidate.decide",
      decision: { candidateId: request.candidateId, decision: "reject" },
    };
  }

  const edited = intent.fact?.trim();

  return {
    operation: "candidate.decide",
    decision: {
      candidateId: request.candidateId,
      decision: "approve",
      ...(edited && edited !== request.fact ? { fact: edited } : {}),
    },
  };
}
