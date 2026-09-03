import { memo } from "react";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
} from "@t3tools/contracts";
import { type PendingApproval } from "../../session-logic";
import { useTheme } from "../../hooks/useTheme";
import { describeCommandApproval } from "~/lib/commandApprovalDetails";
import { cn } from "~/lib/utils";
import { ShellCommandCode } from "./ShellCommandCode";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
  hideLabel?: boolean;
}

// The drawer already owns a surface, so the detail well is an inset fill rather
// than a second bordered card.
const DETAIL_SURFACE_CLASS_NAME = "rounded-lg bg-background/45 px-3 py-2.5";

function CommandGlyph() {
  return (
    <span
      aria-hidden="true"
      className="flex size-5 shrink-0 items-center justify-center rounded-md bg-foreground/[0.07] font-mono text-[10px] text-muted-foreground"
    >
      $
    </span>
  );
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
  hideLabel = false,
}: ComposerPendingApprovalPanelProps) {
  const { resolvedTheme } = useTheme();
  const isProductFeedback = approval.toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME;
  const isRoutine = approval.toolName === AKERU_CREATE_ROUTINE_TOOL_NAME;
  const routineArgs =
    isRoutine && approval.args && typeof approval.args === "object"
      ? (approval.args as Record<string, unknown>)
      : null;
  const routineName = typeof routineArgs?.name === "string" ? routineArgs.name : "New routine";
  const routineInstructions =
    typeof routineArgs?.instructions === "string" ? routineArgs.instructions : null;
  const routineSchedule =
    routineArgs?.schedule && typeof routineArgs.schedule === "object"
      ? (routineArgs.schedule as Record<string, unknown>)
      : null;
  const scheduleTime = typeof routineSchedule?.time === "string" ? routineSchedule.time : null;
  const scheduleTimezone = typeof routineArgs?.timezone === "string" ? routineArgs.timezone : null;
  const weeklyDays = Array.isArray(routineSchedule?.weekdays)
    ? routineSchedule.weekdays.filter((day): day is string => typeof day === "string")
    : [];
  const scheduleKind =
    routineSchedule?.kind === "weekdays"
      ? "Weekdays"
      : routineSchedule?.kind === "weekly"
        ? weeklyDays.length > 0
          ? weeklyDays.map((day) => `${day.slice(0, 1).toUpperCase()}${day.slice(1)}`).join(", ")
          : "Weekly"
        : "Daily";
  const fallbackLabel = isRoutine
    ? "Routine approval"
    : isProductFeedback
      ? "Product feedback approval"
      : approval.requestKind === "mcp-elicitation"
        ? "App access approval"
        : approval.requestKind === "command"
          ? "Command approval"
          : approval.requestKind === "file-read"
            ? "File read approval"
            : "File change approval";
  const detailAriaLabel = isRoutine
    ? "Routine details"
    : isProductFeedback
      ? "Product feedback draft"
      : approval.requestKind === "mcp-elicitation"
        ? "App access request"
        : approval.requestKind === "command"
          ? "Command"
          : approval.requestKind === "file-read"
            ? "File to read"
            : "File change";
  const argsCommand =
    approval.requestKind === "command" &&
    approval.args &&
    typeof approval.args === "object" &&
    "command" in approval.args &&
    typeof approval.args.command === "string"
      ? approval.args.command
      : null;
  const command =
    approval.requestKind === "command"
      ? (argsCommand ?? (approval.detail?.trim() ? approval.detail : fallbackLabel))
      : null;
  const detail = command ?? approval.detail ?? fallbackLabel;
  const details = command ? describeCommandApproval(command, approval.args) : null;
  const firstLine = detail.split("\n", 1)[0] ?? detail;
  const detailLineCount = detail.split("\n").length;
  // Only hide detail behind a disclosure when there is more than one screenful
  // of it. A one-line path behind "Expand" wastes a click.
  const detailFitsInline = detailLineCount <= 4 && detail.length <= 400;

  if (isRoutine) {
    return (
      <div
        aria-label={fallbackLabel}
        className={cn("flex min-w-0 flex-1 flex-col gap-2", className)}
        role="group"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-medium text-foreground">Review routine</span>
          {pendingCount > 1 ? (
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              1/{pendingCount}
            </span>
          ) : null}
        </div>
        <div aria-label={detailAriaLabel} className="rounded-lg bg-foreground/[0.04] px-3 py-2.5">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="truncate text-sm font-medium text-foreground">{routineName}</span>
            {scheduleTime ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {scheduleKind} at {scheduleTime}
                {scheduleTimezone ? ` (${scheduleTimezone})` : ""}
              </span>
            ) : null}
          </div>
          {routineInstructions ? (
            <p className="mt-1.5 line-clamp-3 text-xs leading-5 text-muted-foreground">
              {routineInstructions}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      aria-label={fallbackLabel}
      className={cn("flex min-w-0 flex-1 flex-col gap-1.5", className)}
      role="group"
    >
      {!hideLabel ? (
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
      ) : null}
      {command ? (
        <>
          <div
            aria-label={detailAriaLabel}
            className={cn("flex min-w-0 items-start gap-2", DETAIL_SURFACE_CLASS_NAME)}
            role="region"
          >
            <CommandGlyph />
            <code
              className="block max-h-28 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/90 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5"
              data-approval-detail="complete"
              tabIndex={0}
            >
              <ShellCommandCode command={command} theme={resolvedTheme} />
            </code>
          </div>
          {details && (details.signals.length > 0 || details.workingDirectory || details.reason) ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-0.5">
              {details.signals.map((signal) => (
                <span
                  className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                  key={signal}
                >
                  {signal}
                </span>
              ))}
              {details.workingDirectory ? (
                <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                  {details.workingDirectory}
                </span>
              ) : null}
              {details.reason ? (
                <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                  {details.reason}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : detailFitsInline ? (
        <div className={cn("flex min-w-0 flex-col", DETAIL_SURFACE_CLASS_NAME)}>
          <code
            aria-label={detailAriaLabel}
            className="block min-w-0 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/90"
            data-approval-detail="complete"
          >
            {detail}
          </code>
        </div>
      ) : (
        <details className="group w-full min-w-0">
          <summary
            className={cn(
              "flex cursor-pointer list-none items-center gap-2 marker:content-none",
              DETAIL_SURFACE_CLASS_NAME,
            )}
          >
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
              {firstLine}
            </code>
            <span className="shrink-0 text-[11px] text-muted-foreground group-open:hidden">
              {detailLineCount} lines
            </span>
            <span className="hidden shrink-0 text-[11px] text-muted-foreground group-open:inline">
              Collapse
            </span>
          </summary>
          <div className="mt-1.5 flex min-w-0 flex-col gap-2 rounded-lg bg-background/45 px-3 py-2.5">
            <code
              aria-label={detailAriaLabel}
              className="block max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground/90 [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 [&::-webkit-scrollbar]:h-1.5"
              data-approval-detail="complete"
              tabIndex={0}
            >
              {detail}
            </code>
          </div>
        </details>
      )}
    </div>
  );
});
