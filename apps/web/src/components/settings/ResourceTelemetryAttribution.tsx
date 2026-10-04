import type { ResourceAttributionEntry } from "@akeru/contracts";
import { formatBytes } from "./resourceTelemetryPresentation";

export function AttributionTable({
  entries,
}: {
  entries: ReadonlyArray<ResourceAttributionEntry>;
}) {
  return (
    <div className="overflow-x-auto border-t border-border/60">
      <table className="w-full min-w-180 table-fixed text-left text-xs">
        <colgroup>
          <col className="w-11/50" />
          <col className="w-7/25" />
          <col className="w-7/50" />
          <col className="w-7/50" />
          <col className="w-1/10" />
          <col className="w-3/25" />
        </colgroup>
        <thead className="border-b border-border/60 text-10px uppercase tracking-caps text-muted-foreground/65">
          <tr>
            <th className="px-4 py-2 font-semibold sm:pl-5">Component</th>
            <th className="px-3 py-2 font-semibold">Operation</th>
            <th className="px-3 py-2 text-right font-semibold">Logical Read</th>
            <th className="px-3 py-2 text-right font-semibold">Logical Write</th>
            <th className="px-3 py-2 text-right font-semibold">Count</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-5">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {entries.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-5 text-xs text-muted-foreground sm:px-5">
                No instrumented application I/O has been recorded yet.
              </td>
            </tr>
          ) : null}
          {entries.map((entry) => (
            <tr key={`${entry.component}:${entry.operation}`} className="hover:bg-muted/20">
              <td className="truncate px-4 py-2 font-medium text-foreground sm:pl-5">
                {entry.component}
              </td>
              <td className="truncate px-3 py-2 text-muted-foreground">{entry.operation}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-telemetry-read-foreground">
                {formatBytes(entry.logicalReadBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-telemetry-write-foreground">
                {formatBytes(entry.logicalWriteBytes)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">{entry.count}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground sm:pr-5">
                {(entry.durationMs / 1_000).toFixed(2)}s
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
