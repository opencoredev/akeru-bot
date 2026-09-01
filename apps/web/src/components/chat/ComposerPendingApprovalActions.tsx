import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderRequestKind,
} from "@t3tools/contracts";
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

const APPROVAL_ACTION_CLASS_NAME = "font-normal";
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
    options.find((option) => option.decision === "acceptForSession") ??
    ({ decision: "acceptForSession", label: "Always allow" } as const);
  const once =
    options.find((option) => option.decision === "accept") ??
    ({ decision: "accept", label: "Allow once" } as const);
  const never =
    options.find((option) => option.decision === "decline") ??
    options.find((option) => option.decision === "cancel") ??
    ({ decision: "decline", label: "Never" } as const);

  return [
    { ...always, label: "Always allow" },
    { ...once, label: "Allow once" },
    { ...never, label: "Never" },
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
  const visibleOptions =
    toolName === AKERU_CREATE_ROUTINE_TOOL_NAME
      ? ROUTINE_APPROVAL_OPTIONS
      : requestKind === "command"
        ? commandApprovalOptions(options)
        : options;

  return (
    <>
      {visibleOptions.map((option) => (
        <Button
          key={option.decision}
          size="micro"
          variant="ghost-muted"
          className={`${APPROVAL_ACTION_CLASS_NAME}${
            option.decision === "decline" && requestKind !== "command"
              ? " text-destructive-foreground [:hover,[data-pressed]]:text-destructive-foreground"
              : option.decision === "accept"
                ? " text-foreground"
                : ""
          }`}
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, option.decision)}
        >
          <span className="max-w-40 truncate">{option.label}</span>
        </Button>
      ))}
    </>
  );
});
