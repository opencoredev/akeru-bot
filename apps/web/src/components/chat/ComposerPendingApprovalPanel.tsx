import { ClockIcon } from "lucide-react";
import { memo } from "react";
import {
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
} from "@t3tools/contracts";
import { type PendingApproval } from "../../session-logic";
import { describeCommandApproval } from "~/lib/commandApprovalDetails";
import { cn } from "~/lib/utils";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  className?: string;
  hideLabel?: boolean;
}

// The drawer already owns a surface, so the detail well is an inset fill rather
// than a second bordered card.
const DETAIL_SURFACE_CLASS_NAME = "rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5";

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

interface RoutineProposalDetails {
  readonly name: string | null;
  readonly instructions: string | null;
  readonly schedule: string | null;
  readonly timezone: string | null;
  readonly uses: ReadonlyArray<string>;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

function capitalize(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function routineInstructions(instructions: string | null, schedule: unknown): string | null {
  if (!instructions) return null;
  if (!schedule || typeof schedule !== "object") return instructions;
  const kind = (schedule as Record<string, unknown>).kind;
  const comma = instructions.indexOf(",");
  if (comma < 0) return instructions;
  const lead = instructions.slice(0, comma).trim();
  const task = instructions.slice(comma + 1).trim();
  if (!task) return instructions;
  const duplicatesSchedule =
    (kind === "daily" && /^(?:every day|every morning|daily)\b/i.test(lead)) ||
    (kind === "weekdays" && /^(?:every weekday|on weekdays|weekdays)\b/i.test(lead)) ||
    (kind === "weekly" &&
      /^every (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(lead));
  return duplicatesSchedule ? capitalize(task) : instructions;
}

// Describes only what the draft states. An unknown or missing schedule yields
// null rather than a guessed default.
function routineScheduleText(schedule: unknown): string | null {
  if (!schedule || typeof schedule !== "object") return null;
  const record = schedule as Record<string, unknown>;
  const time = stringField(record, "time");
  if (!time) return null;
  if (record.kind === "daily") return `Every day at ${time}`;
  if (record.kind === "weekdays") return `Weekdays at ${time}`;
  if (record.kind === "weekly") {
    const days = stringList(record.weekdays).map(capitalize);
    if (days.length === 0) return null;
    return `Every ${new Intl.ListFormat("en", { type: "conjunction" }).format(days)} at ${time}`;
  }
  return null;
}

export function routineProposalDetails(args: unknown): RoutineProposalDetails | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  const details = {
    name: stringField(record, "name"),
    instructions: routineInstructions(stringField(record, "instructions"), record.schedule),
    schedule: routineScheduleText(record.schedule),
    timezone: stringField(record, "timezone"),
    uses: [...stringList(record.skillNames), ...stringList(record.connectorNames)],
  };
  return details.name || details.instructions || details.schedule ? details : null;
}

function RoutineProposal({
  args,
  className,
  hideLabel,
  label,
  pendingCount,
}: {
  args: unknown;
  className: string | undefined;
  hideLabel: boolean;
  label: string;
  pendingCount: number;
}) {
  const details = routineProposalDetails(args);
  return (
    <div
      aria-label={label}
      className={cn("flex min-w-0 flex-1 flex-col gap-2", className)}
      role="group"
    >
      {!hideLabel ? (
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-medium text-foreground">Review routine</span>
          {pendingCount > 1 ? (
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
              1/{pendingCount}
            </span>
          ) : null}
        </div>
      ) : null}
      {details ? (
        <div
          aria-label="Routine details"
          className="flex min-w-0 flex-col gap-2.5"
          data-testid="routine-proposal"
        >
          {details.name ? (
            <p className="min-w-0 text-base font-semibold leading-5 text-foreground">
              {details.name}
            </p>
          ) : null}
          {details.schedule ? (
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <ClockIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">
                {details.schedule}
                {details.timezone ? (
                  <span className="text-muted-foreground"> · {details.timezone}</span>
                ) : null}
              </span>
            </p>
          ) : null}
          {details.instructions ? (
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-muted-foreground">What it does</p>
              <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-5 text-foreground/90">
                {details.instructions}
              </p>
            </div>
          ) : null}
          {details.uses.length > 0 ? (
            <p className="min-w-0 truncate text-[11px] text-muted-foreground">
              Uses {details.uses.join(", ")}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          The routine details did not come through. Read the bot's last message before creating it.
        </p>
      )}
    </div>
  );
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  className,
  hideLabel = false,
}: ComposerPendingApprovalPanelProps) {
  const isProductFeedback = approval.toolName === AKERU_PRODUCT_FEEDBACK_TOOL_NAME;
  const isRoutine = approval.toolName === AKERU_CREATE_ROUTINE_TOOL_NAME;
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
      <RoutineProposal
        args={approval.args}
        className={className}
        hideLabel={hideLabel}
        label={fallbackLabel}
        pendingCount={pendingCount}
      />
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
              {command}
            </code>
          </div>
          {details && (details.signals.length > 0 || details.workingDirectory || details.reason) ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-0.5">
              {details.signals.map((signal) => (
                <span
                  className="rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
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
          <div className="mt-1.5 flex min-w-0 flex-col gap-2 rounded-lg border border-border/50 bg-muted/30 px-3 py-2.5">
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
