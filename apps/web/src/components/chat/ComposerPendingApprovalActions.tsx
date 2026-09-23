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
import { useI18n } from "~/i18n";
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

type Translate = ReturnType<typeof useI18n>["t"];

function defaultApprovalOptions(t: Translate): ReadonlyArray<ProviderApprovalOption> {
  return [
    { decision: "cancel", label: t("Cancel") },
    { decision: "decline", label: t("Decline") },
    { decision: "acceptForSession", label: t("Always allow this session") },
    { decision: "accept", label: t("Approve") },
  ];
}

function routineApprovalOptions(t: Translate): ReadonlyArray<ProviderApprovalOption> {
  return [
    { decision: "accept", label: t("Create routine") },
    { decision: "decline", label: t("Cancel") },
  ];
}

function commandApprovalOptions(
  options: ReadonlyArray<ProviderApprovalOption>,
  t: Translate,
): ReadonlyArray<ProviderApprovalOption> {
  const always =
    options.find((option) => option.decision === "acceptAlways") ??
    options.find((option) => option.decision === "acceptForSession");
  const once =
    options.find((option) => option.decision === "accept") ??
    ({ decision: "accept", label: t("Allow once") } as const);
  const never =
    options.find((option) => option.decision === "decline") ??
    options.find((option) => option.decision === "cancel") ??
    ({ decision: "decline", label: t("Never") } as const);

  return [
    { ...never, label: t("Never") },
    ...(always ? [{ ...always, label: t("Enable Auto Review") } as const] : []),
    { ...once, label: t("Allow once") },
  ];
}

const AUTO_REVIEW_DECISIONS = new Set(["acceptAlways", "acceptForSession"]);

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  requestKind,
  toolName,
  isResponding,
  options: providedOptions,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const { t } = useI18n();
  const options = providedOptions ?? defaultApprovalOptions(t);
  const visibleOptions =
    toolName === AKERU_CREATE_ROUTINE_TOOL_NAME
      ? routineApprovalOptions(t)
      : toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME
        ? options
        : requestKind === "command"
          ? commandApprovalOptions(options, t)
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
            {...(isAutoReview
              ? { title: t("Let Auto Review decide the rest of this session") }
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
