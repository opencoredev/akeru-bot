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
  { decision: "decline", label: "Don't create" },
] satisfies ReadonlyArray<ProviderApprovalOption>;
const APPROVAL_ACCEPT_CLASS_NAME =
  " bg-foreground text-background [:active,[data-pressed]]:bg-foreground/80 [:hover,[data-pressed]]:bg-foreground/90";

function commandApprovalOptions(
  options: ReadonlyArray<ProviderApprovalOption>,
): ReadonlyArray<ProviderApprovalOption> {
  const autoReview = options.find((option) => option.decision === "acceptAlways");
  const session = options.find((option) => option.decision === "acceptForSession");
  const once =
    options.find((option) => option.decision === "accept") ??
    ({ decision: "accept", label: "Allow once" } as const);
  const never =
    options.find((option) => option.decision === "decline") ??
    options.find((option) => option.decision === "cancel") ??
    ({ decision: "decline", label: "Never" } as const);

  return [
    { ...never, label: "Never" },
    ...(autoReview
      ? [{ ...autoReview, label: "Enable Auto Review" } as const]
      : session
        ? [session]
        : []),
    { ...once, label: "Allow once" },
  ];
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  requestKind,
  toolName,
  isResponding,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const isRoutine = toolName === AKERU_CREATE_ROUTINE_TOOL_NAME;
  const visibleOptions = isRoutine
    ? ROUTINE_APPROVAL_OPTIONS
    : toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME
      ? options
      : requestKind === "command"
        ? commandApprovalOptions(options)
        : options;

  return (
    <>
      {visibleOptions.map((option) => {
        const isAutoReview = requestKind === "command" && option.decision === "acceptAlways";
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
              option.decision === "accept"
                ? APPROVAL_ACCEPT_CLASS_NAME
                : option.decision === "acceptAlways" || option.decision === "acceptForSession"
                  ? " border-border bg-muted/40 text-foreground [:hover,[data-pressed]]:bg-muted/70"
                  : " text-muted-foreground [:hover,[data-pressed]]:text-foreground"
            }`}
            disabled={isResponding}
            onClick={() => void onRespondToApproval(requestId, option.decision)}
            {...(isAutoReview
              ? { title: "Switch to Auto Review. Safe actions run, sensitive ones still ask." }
              : {})}
          >
            {isAutoReview ? <ShieldCheckIcon aria-hidden="true" /> : null}
            <span className="max-w-40 truncate">{option.label}</span>
          </Button>
        );
      })}
    </>
  );
});
