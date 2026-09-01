import { memo } from "react";
import { AKERU_PRODUCT_FEEDBACK_TOOL_NAME } from "@t3tools/contracts";
import { type PendingApproval } from "../../session-logic";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
}: ComposerPendingApprovalPanelProps) {
  const isProductFeedback = approval.toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME;
  const fallbackLabel = isProductFeedback
    ? "Product feedback approval"
    : approval.requestKind === "mcp-elicitation"
      ? "App access approval"
      : approval.requestKind === "command"
        ? "Command approval"
        : approval.requestKind === "file-read"
          ? "File read approval"
          : "File change approval";
  const detailAriaLabel = isProductFeedback
    ? "Product feedback draft"
    : approval.requestKind === "mcp-elicitation"
      ? "App access request"
      : approval.requestKind === "command"
        ? "Command"
        : approval.requestKind === "file-read"
          ? "File to read"
          : "File change";
  const command =
    approval.requestKind === "command" &&
    approval.args &&
    typeof approval.args === "object" &&
    "command" in approval.args &&
    typeof approval.args.command === "string"
      ? approval.args.command
      : null;
  const detail = command ?? approval.detail ?? fallbackLabel;

  return (
    <div
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col gap-1.5", className)}
      role="group"
    >
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className="text-xs font-medium text-foreground">{fallbackLabel}</span>
        {approval.appName ? (
          <span className="max-w-32 shrink truncate text-[11px] text-muted-foreground">
            {approval.appName}
          </span>
        ) : null}
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 text-[10px] font-medium text-muted-foreground tabular-nums">
            1/{pendingCount}
          </span>
        ) : null}
      </div>
      <details className="group w-full min-w-0">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md bg-foreground/[0.04] px-2.5 py-2 marker:content-none">
          <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/85">
            {detail.split("\n", 1)[0]}
          </code>
          <span className="shrink-0 text-[10px] text-muted-foreground group-open:hidden">
            Expand
          </span>
          <span className="hidden shrink-0 text-[10px] text-muted-foreground group-open:inline">
            Collapse
          </span>
        </summary>
        <code
          aria-label={detailAriaLabel}
          className="mt-1.5 block max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-foreground/[0.04] px-2.5 py-2 font-mono text-[11px] text-foreground/85 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5"
          data-approval-detail="complete"
          tabIndex={0}
        >
          {detail}
        </code>
      </details>
    </div>
  );
});
