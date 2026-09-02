import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderRequestKind,
} from "@t3tools/contracts";
import { ShieldCheckIcon } from "lucide-react";
import { memo } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  requestKind?: ProviderRequestKind | undefined;
  toolName?: string | undefined;
  isResponding: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const APPROVAL_ACTION_CLASS_NAME = "font-medium";
const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;
const ROUTINE_APPROVAL_OPTIONS = [
  { decision: "accept", label: "Create routine" },
  { decision: "decline", label: "Cancel" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

function commandApprovalOptions(
  options: ReadonlyArray<ProviderApprovalOption>,
): ReadonlyArray<ProviderApprovalOption> {
  const always =
    options.find((option) => option.decision === "acceptAlways") ??
    options.find((option) => option.decision === "acceptForSession");
  const once =
    options.find((option) => option.decision === "accept") ??
    ({ decision: "accept", label: "Allow once" } as const);
  const never =
    options.find((option) => option.decision === "decline") ??
    options.find((option) => option.decision === "cancel") ??
    ({ decision: "decline", label: "Never" } as const);

  return [
    { ...never, label: "Never" },
    ...(always ? [{ ...always, label: "Enable Auto Review" } as const] : []),
    { ...once, label: "Allow once" },
  ];
}

const AUTO_REVIEW_DECISIONS = new Set(["acceptAlways", "acceptForSession"]);

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  requestKind,
  toolName,
  isResponding,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const visibleOptions =
    toolName === AKERU_CREATE_ROUTINE_TOOL_NAME
      ? ROUTINE_APPROVAL_OPTIONS
      : toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME
        ? options
        : requestKind === "command"
          ? commandApprovalOptions(options)
          : options;

  return (
    <>
      {visibleOptions.map((option) => {
        const isAutoReview =
          requestKind === "command" && AUTO_REVIEW_DECISIONS.has(option.decision);
        return (
          <Button
            key={option.decision}
            size="xs"
            variant={
              option.decision === "accept"
                ? "default"
                : option.decision === "acceptAlways" || option.decision === "acceptForSession"
                  ? "outline"
                  : "ghost-muted"
            }
            className={`${APPROVAL_ACTION_CLASS_NAME}${
              option.decision === "decline" || option.decision === "cancel"
                ? " text-destructive-foreground [:hover,[data-pressed]]:text-destructive-foreground"
                : isAutoReview
                  ? " border-primary/45 bg-primary/[0.04] [--control-icon-color:var(--color-primary)] [:hover,[data-pressed]]:border-primary/70 [:hover,[data-pressed]]:bg-primary/[0.08]"
                  : ""
            }`}
            disabled={isResponding}
            onClick={() => void onRespondToApproval(requestId, option.decision)}
            {...(isAutoReview ? { title: "Let Auto Review decide the rest of this session" } : {})}
          >
            {isAutoReview ? <ShieldCheckIcon aria-hidden="true" /> : null}
            <span className="max-w-40 truncate">{option.label}</span>
          </Button>
        );
      })}
    </>
  );
});
