import type {
  BackgroundBooleanState,
  ResourceTelemetryIoSemantics,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessCategory,
  ResourceTelemetryProcessSummary,
  ResourceTelemetrySourceStatus,
} from "@akeru/contracts";

export function formatBytes(value: number): string {
  if (value < 1_024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let next = value;
  let unitIndex = -1;

  do {
    next /= 1_024;
    unitIndex += 1;
  } while (next >= 1_024 && unitIndex < units.length - 1);

  return `${next.toFixed(next >= 100 ? 0 : next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

export function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

export function formatCpuTime(valueMs: number): string {
  const seconds = valueMs / 1_000;

  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  const minutes = seconds / 60;

  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`;

  return `${(minutes / 60).toFixed(2)}h`;
}

export function formatDurationMicros(value: number): string {
  if (value < 1_000) return `${Math.round(value)} µs`;

  if (value < 1_000_000) return `${(value / 1_000).toFixed(2)} ms`;

  return `${(value / 1_000_000).toFixed(2)} s`;
}

export function formatSampleInterval(valueMs: number): string {
  if (valueMs < 1_000) return `${Math.max(0, Math.round(valueMs))} ms`;
  const seconds = valueMs / 1_000;

  return `${seconds.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${
    seconds === 1 ? "second" : "seconds"
  }`;
}

export function processIdentityKey(process: ResourceTelemetryProcess): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

export function processSummaryIdentityKey(process: ResourceTelemetryProcessSummary): string {
  return `${process.identity.pid}:${process.identity.startTimeMs}`;
}

export function formatProcessName(
  process: Pick<ResourceTelemetryProcess, "command" | "name">,
): string {
  if (process.name.trim()) return process.name;
  const firstToken = process.command.trim().split(/\s+/)[0] ?? process.command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");

  return normalized.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? normalized;
}

export function categoryLabel(category: ResourceTelemetryProcessCategory): string {
  switch (category) {
    case "server":
      return "Server";
    case "server-child":
      return "Backend child";
    case "provider-root":
      return "Provider";
    case "terminal-root":
      return "Terminal";
    case "electron-main":
      return "Electron main";
    case "electron-renderer":
      return "Renderer";
    case "electron-gpu":
      return "GPU";
    case "electron-utility":
      return "Electron utility";
    case "resource-monitor":
      return "Monitor";
    case "unknown-t3":
      return "Akeru Bot process";
  }
}

/* oxlint-disable shadcn/no-raw-colors -- Nominal process categories retain their distinct data colors. */
export const RESOURCE_AGGREGATE_COLORS = {
  server: "bg-emerald-500/80",
  electron: "bg-sky-500/80",
  monitor: "bg-amber-500/80",
};

export const RESOURCE_CATEGORY_COLORS = {
  monitor: "bg-amber-500",
  electron: "bg-sky-500",
  server: "bg-violet-500",
  child: "bg-emerald-500",
};

export function categoryDotClass(category: ResourceTelemetryProcessCategory): string {
  if (category === "resource-monitor") return RESOURCE_CATEGORY_COLORS.monitor;

  if (category.startsWith("electron-")) return RESOURCE_CATEGORY_COLORS.electron;

  if (category === "server") return RESOURCE_CATEGORY_COLORS.server;

  return RESOURCE_CATEGORY_COLORS.child;
}

export function ioSemanticsLabel(semantics: ResourceTelemetryIoSemantics): string {
  switch (semantics) {
    case "storage":
      return "Storage bytes";
    case "logical":
      return "Logical bytes";
    case "all-io":
      return "All I/O bytes";
    case "unavailable":
      return "Unavailable";
  }
}

export function booleanStateLabel(
  value: BackgroundBooleanState,
  labels: { readonly true: string; readonly false: string },
): string {
  if (value === "true") return labels.true;

  if (value === "false") return labels.false;

  return "Unknown";
}

export function sourceStatusTone(
  status: ResourceTelemetrySourceStatus,
): "default" | "warning" | "danger" {
  if (status === "healthy") return "default";

  if (status === "starting" || status === "degraded") return "warning";

  return "danger";
}
