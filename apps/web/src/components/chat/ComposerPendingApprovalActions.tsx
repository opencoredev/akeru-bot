import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderRequestKind,
} from "@akeru/contracts";
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
    { decision: "decline", label: t("Don't create") },
  ];
}
const APPROVAL_ACCEPT_CLASS_NAME =
  " bg-foreground text-background [:active,[data-pressed]]:bg-foreground/80 [:hover,[data-pressed]]:bg-foreground/90";

function commandApprovalOptions(
  options: ReadonlyArray<ProviderApprovalOption>,
  t: Translate,
): ReadonlyArray<ProviderApprovalOption> {
  const autoReview = options.find((option) => option.decision === "acceptAlways");
  const session = options.find((option) => option.decision === "acceptForSession");
  const once =
    options.find((option) => option.decision === "accept") ??
    ({ decision: "accept", label: t("Allow once") } as const);
  const never =
    options.find((option) => option.decision === "decline") ??
    options.find((option) => option.decision === "cancel") ??
    ({ decision: "decline", label: t("Never") } as const);

  return [
    { ...never, label: t("Never") },
    ...(autoReview
      ? [{ ...autoReview, label: t("Enable Auto Review") } as const]
      : session
        ? [session]
        : []),
    { ...once, label: t("Allow once") },
  ];
}

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
  const isRoutine = toolName === AKERU_CREATE_ROUTINE_TOOL_NAME;
  const visibleOptions = isRoutine
    ? routineApprovalOptions(t)
    : toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME
      ? options
      : requestKind === "command"
        ? commandApprovalOptions(options, t)
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
              ? { title: t("Switch to Auto Review. Safe actions run, sensitive ones still ask.") }
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
