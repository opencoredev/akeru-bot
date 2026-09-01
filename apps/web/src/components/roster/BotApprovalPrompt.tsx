import type { ProviderApprovalDecision } from "@t3tools/contracts";

import type { PendingApproval } from "../../session-logic";
import { ComposerPendingApprovalActions } from "../chat/ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "../chat/ComposerPendingApprovalPanel";

export function BotApprovalPrompt({
  approval,
  pendingCount,
  responding,
  error,
  onRespond,
}: {
  readonly approval: PendingApproval;
  readonly pendingCount: number;
  readonly responding: boolean;
  readonly error: string | null;
  readonly onRespond: (decision: ProviderApprovalDecision) => Promise<unknown>;
}) {
  const oneUse =
    approval.options?.every(
      (option) => option.decision !== "acceptForSession" && option.decision !== "acceptAlways",
    ) ?? false;

  return (
    <section
      aria-label="Approval required"
      className="w-full max-w-2xl rounded-2xl border border-border bg-foreground/5 p-3"
      data-testid="bot-approval-prompt"
    >
      <p className="text-sm font-medium">Approval required</p>
      {oneUse ? (
        <p className="mt-1 text-xs text-muted-foreground">
          This approval applies only to this action. It cannot undo completed work.
        </p>
      ) : null}
      <ComposerPendingApprovalPanel
        approval={approval}
        pendingCount={pendingCount}
        className="mt-2"
      />
      <div className="mt-3 flex justify-end gap-1">
        <ComposerPendingApprovalActions
          requestId={approval.requestId}
          isResponding={responding}
          options={approval.options}
          onRespondToApproval={(_requestId, decision) => onRespond(decision)}
        />
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
