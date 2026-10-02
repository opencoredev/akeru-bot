import {
  AkeruMemoryCandidateId,
  AkeruMemoryRootId,
  type AkeruMemoryCandidateDecision,
  type AkeruMemoryDecisionReceipt,
  type AkeruMemoryShareScope,
  type AkeruMemoryTargetScope,
  type AkeruMemoryThreadAccess,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class MemoryApprovalError extends Schema.TaggedErrorClass<MemoryApprovalError>()(
  "MemoryApprovalError",
  { message: Schema.String },
) {}

export interface MemoryShareProposal {
  readonly access: AkeruMemoryThreadAccess;
  readonly fact: string;
  readonly scope: AkeruMemoryShareScope;
  readonly sensitive: boolean;
  // "auto" saves non-sensitive shared facts without asking.
  readonly mode: "ask" | "auto";
}

export type MemoryShareResult =
  | { readonly status: "saved"; readonly memoryId: AkeruMemoryRootId }
  | { readonly status: "pending"; readonly candidateId: AkeruMemoryCandidateId };

export interface MemoryApprovalsShape {
  // Called by the memory tool when a bot wants to save a shared fact.
  readonly propose: (
    input: MemoryShareProposal,
  ) => Effect.Effect<MemoryShareResult, MemoryApprovalError>;
  // Called when a person approves or rejects a pending candidate from the
  // chat card or the bot inbox. Deciding twice returns the first receipt.
  readonly decide: (input: {
    readonly access: AkeruMemoryThreadAccess;
    readonly decision: AkeruMemoryCandidateDecision;
  }) => Effect.Effect<AkeruMemoryDecisionReceipt, MemoryApprovalError>;
}

export const memoryApprovalIncidentKey = (candidateId: string) => `memory-approval:${candidateId}`;

export const SCOPE_LABELS: Record<AkeruMemoryTargetScope, string> = {
  private: "private",
  bot: "this bot's",
  project: "project",
  group: "group",
  workspace: "workspace",
};

export const INBOX_SUMMARY_MAX_CHARS = 240;

export const boundedSummary = (value: string) =>
  value.length <= INBOX_SUMMARY_MAX_CHARS
    ? value
    : `${value.slice(0, INBOX_SUMMARY_MAX_CHARS - 1)}…`;
