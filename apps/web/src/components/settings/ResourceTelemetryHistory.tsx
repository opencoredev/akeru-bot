import type { ResourceTelemetryHistoryBucket } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  resourceHistoryBarHeight,
  resourceHistoryCpuScaleMax,
} from "./ResourceTelemetryDiagnostics.logic";
import { formatBytes } from "./resourceTelemetryPresentation";

export const HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 15_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 30_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 2 * 60_000 },
] as const;

const IO_READ_COLOR = "bg-telemetry-read/70";

const IO_WRITE_COLOR = "bg-telemetry-write/80";

export function HistoryWindowSelector({
  selectedWindowMs,
  onSelect,
}: {
  selectedWindowMs: number;
  onSelect: (windowMs: number) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-border/60 p-0.5">
      {HISTORY_WINDOWS.map((option) => (
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

export function ResourceHistoryChart({
  buckets,
}: {
  buckets: ReadonlyArray<ResourceTelemetryHistoryBucket>;
}) {
  const maxCpu = resourceHistoryCpuScaleMax(buckets);
  const maxIo = Math.max(1, ...buckets.map((bucket) => bucket.ioReadBytes + bucket.ioWriteBytes));

  return (
    <div className="border-t border-border/60 px-4 py-4 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-10px text-muted-foreground/65">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-3 rounded-full bg-foreground/70" /> CPU average
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("h-1.5 w-3 rounded-full", IO_READ_COLOR)} /> I/O reads
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("h-1.5 w-3 rounded-full", IO_WRITE_COLOR)} /> I/O writes
        </span>
      </div>
      <div className="flex h-32 items-end gap-1 overflow-hidden rounded-lg border border-border/40 bg-muted/8 px-2 pt-3 pb-2">
        {buckets.map((bucket) => {
          const cpuHeight = resourceHistoryBarHeight({
            value: bucket.avgCpuPercent,
            max: maxCpu,
            minimumVisiblePercent: 2,
          });

          const readHeight = resourceHistoryBarHeight({
            value: bucket.ioReadBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });

          const writeHeight = resourceHistoryBarHeight({
            value: bucket.ioWriteBytes,
            max: maxIo,
            minimumVisiblePercent: 1,
          });

          return (
            <Tooltip key={DateTime.formatIso(bucket.startedAt)}>
              <TooltipTrigger
                render={
                  <div className="grid h-full min-w-1 flex-1 grid-cols-3 items-end gap-px">
                    <span
                      className="block h-(--bar-height) rounded-t-sm bg-foreground/65"
                      style={{ "--bar-height": `${cpuHeight}%` }}
                    />
                    <span
                      className={cn("block h-(--bar-height) rounded-t-sm", IO_READ_COLOR)}
                      style={{ "--bar-height": `${readHeight}%` }}
                    />
                    <span
                      className={cn("block h-(--bar-height) rounded-t-sm", IO_WRITE_COLOR)}
                      style={{ "--bar-height": `${writeHeight}%` }}
                    />
                  </div>
                }
              />
              <TooltipPopup side="top" variant="telemetry-history">
                <div>CPU avg {bucket.avgCpuPercent.toFixed(1)}%</div>
                <div>CPU peak {bucket.maxCpuPercent.toFixed(1)}%</div>
                <div>Read {formatBytes(bucket.ioReadBytes)}</div>
                <div>Write {formatBytes(bucket.ioWriteBytes)}</div>
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
