import type {
  ResourceTelemetryProcess,
  ResourceTelemetryProcessSummary,
  ServerProcessSignal,
} from "@akeru/contracts";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { visibleResourceTelemetryProcesses } from "./ResourceTelemetryDiagnostics.logic";
import {
  categoryDotClass,
  categoryLabel,
  formatBytes,
  formatCpuTime,
  formatProcessName,
  formatRate,
  ioSemanticsLabel,
  processIdentityKey,
  processSummaryIdentityKey,
} from "./resourceTelemetryPresentation";

export function ProcessTreeName({
  process,
  collapsed,
  onToggle,
}: {
  process: ResourceTelemetryProcess;
  collapsed: boolean;
  onToggle: (process: ResourceTelemetryProcess) => void;
}) {
  const name = formatProcessName(process);
  const hasChildren = process.childPids.length > 0;
  const ChevronIcon = collapsed ? ChevronRightIcon : ChevronDownIcon;

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={
        // oxlint-disable-next-line shadcn/no-inline-styles -- Geometry is computed from the sampled value or process tree depth.
        { paddingLeft: `${Math.min(process.depth, 7) * 10}px` }
      }
    >
      {hasChildren ? (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={() => onToggle(process)}
          aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
        >
          <ChevronIcon className="size-3.5" />
        </Button>
      ) : (
        <span className="size-5" aria-hidden />
      )}
      <span className={cn("size-1.5 rounded-full", categoryDotClass(process.category))} />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup
          side="top"
          variant="diagnostics-mono"
          className="max-w-[min(520px,calc(100vw-2rem))] whitespace-normal break-words text-left"
        >
          {process.command || process.name}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

export function canSignalProcess(process: ResourceTelemetryProcess): boolean {
  return (
    process.category === "server-child" ||
    process.category === "provider-root" ||
    process.category === "terminal-root"
  );
}

export function ProcessActions({
  process,
  signalingKeys,
  onSignal,
}: {
  process: ResourceTelemetryProcess;
  signalingKeys: ReadonlySet<string>;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  if (!canSignalProcess(process)) {
    return <span className="text-[10px] text-muted-foreground/35">—</span>;
  }

  const isSignaling = signalingKeys.has(processIdentityKey(process));

  return (
    <div className="flex items-center justify-end gap-1.5">
      <button
        type="button"
        disabled={isSignaling}
        className="cursor-pointer text-[10px] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-50"
        onClick={() => onSignal(process, "SIGINT")}
      >
        INT
      </button>
      <button
        type="button"
        disabled={isSignaling}
        className="cursor-pointer text-[10px] font-semibold text-destructive hover:underline disabled:opacity-50"
        onClick={() => onSignal(process, "SIGKILL")}
      >
        KILL
      </button>
    </div>
  );
}

export function ProcessTable({
  processes,
  signalingKeys,
  onSignal,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcess>;
  signalingKeys: ReadonlySet<string>;
  onSignal: (process: ResourceTelemetryProcess, signal: ServerProcessSignal) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const visible = useMemo(
    () => visibleResourceTelemetryProcesses(processes, collapsed),
    [collapsed, processes],
  );

  const toggle = useCallback((process: ResourceTelemetryProcess) => {
    const identityKey = processIdentityKey(process);
    setCollapsed((current) => {
      const next = new Set(current);

      if (next.has(identityKey)) {
        next.delete(identityKey);
      } else {
        next.add(identityKey);
      }

      return next;
    });
  }, []);

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      variant="telemetry-process"
      className="max-h-[min(68vh,48rem)] w-full max-w-full"
    >
      <table className="w-full min-w-330 table-fixed text-left text-xs">
        <colgroup>
          <col className="w-1/5" />
          <col className="w-1/10" />
          <col className="w-7/100" />
          <col className="w-2/25" />
          <col className="w-9/100" />
          <col className="w-9/100" />
          <col className="w-9/100" />
          <col className="w-1/10" />
          <col className="w-2/25" />
          <col className="w-3/50" />
          <col className="w-1/25" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-[10px] uppercase tracking-[0.08em] text-muted-foreground/65">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
            <th className="px-3 py-2 font-semibold">Category</th>
            <th className="px-3 py-2 text-right font-semibold">CPU</th>
            <th className="px-3 py-2 text-right font-semibold">CPU Time</th>
            <th className="px-3 py-2 text-right font-semibold">Memory</th>
            <th className="px-3 py-2 text-right font-semibold">Read/s</th>
            <th className="px-3 py-2 text-right font-semibold">Write/s</th>
            <th className="px-3 py-2 text-right font-semibold">Read Total</th>
            <th className="px-3 py-2 text-right font-semibold">Write Total</th>
            <th className="px-3 py-2 text-right font-semibold">PID</th>
            <th className="px-2 py-2 text-right font-semibold sm:pr-4">Kill</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {visible.length === 0 ? (
            <tr>
              <td colSpan={11} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                Waiting for the native process monitor.
              </td>
            </tr>
          ) : null}
          {visible.map((process) => (
            <tr key={processIdentityKey(process)} className="hover:bg-muted/20">
              <td className="px-4 py-2 sm:pl-5">
                <ProcessTreeName
                  process={process}
                  collapsed={collapsed.has(processIdentityKey(process))}
                  onToggle={toggle}
                />
              </td>
              <td className="truncate px-3 py-2 text-[11px] text-muted-foreground">
                {categoryLabel(process.category)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {process.cpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatCpuTime(process.cpuTimeMs)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatBytes(process.residentBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-sky-700 dark:text-sky-300">
                {formatRate(process.ioReadBytesPerSecond)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300">
                {formatRate(process.ioWriteBytesPerSecond)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {formatBytes(process.ioReadBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger render={<span>{formatBytes(process.ioWriteBytes)}</span>} />
                  <TooltipPopup side="top">{ioSemanticsLabel(process.ioSemantics)}</TooltipPopup>
                </Tooltip>
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {process.identity.pid}
              </td>
              <td className="px-2 py-2 text-right sm:pr-4">
                <ProcessActions
                  process={process}
                  signalingKeys={signalingKeys}
                  onSignal={onSignal}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

export function HistoryProcessTable({
  processes,
}: {
  processes: ReadonlyArray<ResourceTelemetryProcessSummary>;
}) {
  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      variant="telemetry-process"
      className="max-h-112 w-full max-w-full"
    >
      <table className="w-full min-w-255 table-fixed text-left text-xs">
        <colgroup>
          <col className="w-6/25" />
          <col className="w-11/100" />
          <col className="w-1/10" />
          <col className="w-1/10" />
          <col className="w-11/100" />
          <col className="w-11/100" />
          <col className="w-11/100" />
          <col className="w-7/100" />
          <col className="w-1/20" />
        </colgroup>
        <thead className="sticky top-0 z-10 border-b border-border/60 bg-card text-[10px] uppercase tracking-[0.08em] text-muted-foreground/65">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Process</th>
            <th className="px-3 py-2 font-semibold">Category</th>
            <th className="px-3 py-2 text-right font-semibold">CPU Time</th>
            <th className="px-3 py-2 text-right font-semibold">Peak CPU</th>
            <th className="px-3 py-2 text-right font-semibold">Peak Mem</th>
            <th className="px-3 py-2 text-right font-semibold">Read</th>
            <th className="px-3 py-2 text-right font-semibold">Write</th>
            <th className="px-3 py-2 text-right font-semibold">Samples</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">PID</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {processes.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                No retained process samples in this window.
              </td>
            </tr>
          ) : null}
          {processes.map((process) => (
            <tr key={processSummaryIdentityKey(process)} className="hover:bg-muted/20">
              <td className="px-4 py-2 sm:pl-5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="block truncate font-medium text-foreground">
                        {process.name || process.command}
                      </span>
                    }
                  />
                  <TooltipPopup
                    side="top"
                    variant="diagnostics-mono"
                    className="max-w-[min(520px,calc(100vw-2rem))] whitespace-normal break-words text-left"
                  >
                    {process.command || process.name}
                  </TooltipPopup>
                </Tooltip>
              </td>
              <td className="truncate px-3 py-2 text-[11px] text-muted-foreground">
                {categoryLabel(process.category)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatCpuTime(process.cpuTimeMs)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {process.maxCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatBytes(process.peakRssBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-sky-700 dark:text-sky-300">
                {formatBytes(process.ioReadBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-amber-700 dark:text-amber-300">
                {formatBytes(process.ioWriteBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {process.sampleCount}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground sm:pr-5">
                {process.identity.pid}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}
