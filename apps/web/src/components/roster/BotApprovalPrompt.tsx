import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";

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
  const isSpecialReview =
    approval.toolName === AKERU_CREATE_ROUTINE_TOOL_NAME ||
    approval.toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME;
  const oneUse =
    !isSpecialReview &&
    (approval.options?.every(
      (option) => option.decision !== "acceptForSession" && option.decision !== "acceptAlways",
    ) ??
      false);
  const heading =
    approval.toolName === AKERU_CREATE_ROUTINE_TOOL_NAME
      ? "Review routine"
      : approval.toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME
        ? "Review product feedback"
        : approval.toolName === "Computer Use"
          ? "Use the computer?"
          : approval.requestKind === "command"
            ? "Run this command?"
            : approval.requestKind === "file-read"
              ? "Read this file?"
              : approval.requestKind === "file-change"
                ? "Change this file?"
                : "Allow app access?";

  return (
    <section
      aria-label="Approval required"
      className="mb-1 w-full rounded-t-[1.65rem] rounded-b-md border border-white/10 border-b-transparent bg-foreground/[0.12] px-3.5 pt-3 pb-2.5 dark:bg-white/[0.16]"
      data-testid="bot-approval-prompt"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber-400" />
        <p className="text-sm font-semibold text-foreground">{heading}</p>
        {approval.appName ? (
          <span className="max-w-32 truncate text-xs text-muted-foreground">
            {approval.appName}
          </span>
        ) : null}
        {oneUse ? <span className="text-xs text-muted-foreground">Runs once</span> : null}
        {pendingCount > 1 ? (
          <span className="ml-auto text-[11px] font-medium text-muted-foreground tabular-nums">
            1 of {pendingCount}
          </span>
        ) : null}
      </div>
      <ComposerPendingApprovalPanel
        approval={approval}
        pendingCount={pendingCount}
        className="mt-2"
        hideLabel
      />
      <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
        <ComposerPendingApprovalActions
          requestId={approval.requestId}
          requestKind={approval.requestKind}
          toolName={approval.toolName}
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
