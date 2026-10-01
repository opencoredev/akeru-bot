import type { ServerProcessResourceHistorySummary } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatBytes } from "./DiagnosticsPresentation";
import { formatProcessName } from "./ProcessDiagnostics";

export const RESOURCE_HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 30_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 60_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 2 * 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 5 * 60_000 },
] as const;

export function formatCpuTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  const minutes = seconds / 60;

  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`;

  return `${(minutes / 60).toFixed(2)}h`;
}

export function formatShortProcessName(command: string): string {
  const name = formatProcessName(command);

  return name.length > 42 ? `${name.slice(0, 39)}...` : name;
}

export function ResourceHistoryProcessNameCell({
  process,
  visualDepth,
}: {
  process: ServerProcessResourceHistorySummary;
  visualDepth: number;
}) {
  const name = formatShortProcessName(process.command);

  return (
    <div
      className="grid min-w-0 grid-cols-legend-row items-center gap-2"
      style={
        // oxlint-disable-next-line shadcn/no-inline-styles -- Geometry is computed from the sampled value or process tree depth.
        { paddingLeft: `${Math.min(visualDepth, 6) * 10}px` }
      }
      aria-label={`${process.isServerRoot ? "Root" : "Child"} process ${name}`}
    >
      <span className="size-5 shrink-0" aria-hidden="true" />
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          process.isServerRoot ? "bg-warning/90" : "bg-success/80",
        )}
      />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup
          side="top"
          variant="diagnostics-process"
          className="max-w-min-440px-vw-2rem whitespace-normal break-words text-left"
        >
          {process.command}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function ProcessResourceHistoryChart({
  buckets,
}: {
  buckets: ReadonlyArray<{
    readonly startedAt: DateTime.Utc;
    readonly avgCpuPercent: number;
    readonly maxCpuPercent: number;
  }>;
}) {
  const maxCpuPercent = Math.max(1, ...buckets.map((bucket) => bucket.maxCpuPercent));

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <div className="flex h-28 items-end gap-1 overflow-hidden rounded-sm bg-muted/10 p-2">
        {buckets.map((bucket) => {
          const peakHeight = Math.max(2, (bucket.maxCpuPercent / maxCpuPercent) * 100);
          const averageHeight = Math.max(2, (bucket.avgCpuPercent / maxCpuPercent) * 100);

          return (
            <Tooltip key={DateTime.formatIso(bucket.startedAt)}>
              <TooltipTrigger
                render={
                  <div className="flex h-full min-w-1 flex-1 items-end">
                    <div
                      className="relative h-full w-full"
                      aria-label={`Average CPU ${bucket.avgCpuPercent.toFixed(1)}%, peak CPU ${bucket.maxCpuPercent.toFixed(1)}%`}
                    >
                      <div
                        className="absolute inset-x-0 bottom-0 rounded-t-sm bg-foreground/15 transition-colors"
                        style={
                          // oxlint-disable-next-line shadcn/no-inline-styles -- Geometry is computed from the sampled value or process tree depth.
                          { height: `${peakHeight}%` }
                        }
                      />
                      <div
                        className="absolute inset-x-0 bottom-0 rounded-t-sm bg-foreground/60 transition-colors"
                        style={
                          // oxlint-disable-next-line shadcn/no-inline-styles -- Geometry is computed from the sampled value or process tree depth.
                          { height: `${averageHeight}%` }
                        }
                      />
                    </div>
                  </div>
                }
              />
              <TooltipPopup side="top">
                Avg {bucket.avgCpuPercent.toFixed(1)}%, peak {bucket.maxCpuPercent.toFixed(1)}%
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

export function ResourceHistoryWindowSelector({
  selectedWindowMs,
  onSelect,
}: {
  selectedWindowMs: number;
  onSelect: (windowMs: number) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-border/60 p-0.5">
      {RESOURCE_HISTORY_WINDOWS.map((option) => (
        <button
          key={option.windowMs}
          type="button"
          className={cn(
            "cursor-pointer h-6 rounded-sm px-2 text-11px font-medium text-muted-foreground hover:text-foreground",
            selectedWindowMs === option.windowMs && "bg-muted text-foreground",
          )}
          onClick={() => onSelect(option.windowMs)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ProcessResourceHistoryTable({
  processes,
  emptyLabel,
}: {
  processes: ReadonlyArray<ServerProcessResourceHistorySummary>;
  emptyLabel: string;
}) {
  const shallowestChildDepth = processes.reduce<number | null>((minDepth, process) => {
    if (process.isServerRoot) return minDepth;

    return minDepth === null ? process.depth : Math.min(minDepth, process.depth);
  }, null);

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      variant="telemetry-process"
      className="max-h-min-64vh-44rem w-full max-w-full"
    >
      <table className="w-full min-w-245 table-fixed text-left text-xs">
        <colgroup>
          <col className="w-6/25" />
          <col className="w-1/10" />
          <col className="w-1/10" />
          <col className="w-1/10" />
          <col className="w-1/10" />
          <col className="w-1/10" />
          <col className="w-4/25" />
          <col className="w-1/10" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-11px uppercase tracking-caps text-muted-foreground/70">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
            <th className="px-3 py-2 text-right font-semibold">CPU Time</th>
            <th className="px-3 py-2 text-right font-semibold">Current</th>
            <th className="px-3 py-2 text-right font-semibold">Average</th>
            <th className="px-3 py-2 text-right font-semibold">Peak</th>
            <th className="px-3 py-2 text-right font-semibold">Max Mem</th>
            <th className="px-3 py-2 font-semibold">Command</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">PID</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {processes.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-4 text-xs text-muted-foreground sm:px-5">
                {emptyLabel}
              </td>
            </tr>
          ) : null}
          {processes.map((process) => (
            <tr key={process.processKey} className="hover:bg-muted/20">
              <td className="px-4 py-2 align-middle sm:pl-5">
                <ResourceHistoryProcessNameCell
                  process={process}
                  visualDepth={
                    process.isServerRoot || shallowestChildDepth === null
                      ? 0
                      : Math.max(1, process.depth - shallowestChildDepth + 1)
                  }
                />
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {formatCpuTime(process.cpuSecondsApprox)}
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.currentCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.avgCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.maxCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {formatBytes(process.maxRssBytes)}
              </td>
              <td className="px-3 py-2 align-middle text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="block truncate">{process.command}</span>}
                  />
                  <TooltipPopup
                    side="top"
                    variant="diagnostics-process"
                    className="max-w-min-440px-vw-2rem whitespace-normal break-words text-left"
                  >
                    {process.command}
                  </TooltipPopup>
                </Tooltip>
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground sm:pr-5">
                {process.pid}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}
