import type {
  DesktopElectronProcessMetric,
  ResourceMonitorProcessSample,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessCategory,
} from "@akeru/contracts";
import { ELECTRON_IDENTITY_TOLERANCE_MS, type ProcessState } from "./ProcessModelTypes.ts";

export function processIdentityKey(pid: number, startTimeMs: number): string {
  return `${pid}:${startTimeMs}`;
}

export function electronCategory(
  metric: DesktopElectronProcessMetric,
): ResourceTelemetryProcessCategory {
  switch (metric.type) {
    case "Browser":
      return "electron-main";
    case "Tab":
      return "electron-renderer";
    case "GPU":
      return "electron-gpu";
    default:
      return "electron-utility";
  }
}

export function inferredElectronCategory(
  process: ResourceMonitorProcessSample,
): ResourceTelemetryProcessCategory {
  const command = process.command.toLowerCase();

  if (command.includes("--type=renderer")) return "electron-renderer";

  if (command.includes("--type=gpu-process")) return "electron-gpu";

  return "electron-utility";
}

export function matchElectronMetric(
  process: ResourceMonitorProcessSample,
  metricsByPid: ReadonlyMap<number, DesktopElectronProcessMetric>,
): DesktopElectronProcessMetric | undefined {
  const metric = metricsByPid.get(process.pid);

  if (!metric) return undefined;

  return Math.abs(metric.creationTimeMs - process.startTimeMs) <= ELECTRON_IDENTITY_TOLERANCE_MS
    ? metric
    : undefined;
}

export function syntheticNativeSample(
  metric: DesktopElectronProcessMetric,
  sampledAtMs: number,
  previous: ProcessState | undefined,
): ResourceMonitorProcessSample {
  const cpuTimeMs =
    metric.cumulativeCpuSeconds !== undefined
      ? Math.max(0, Math.round(metric.cumulativeCpuSeconds * 1_000))
      : previous
        ? previous.process.cpuTimeMs +
          Math.max(0, ((sampledAtMs - previous.sampledAtMs) * metric.cpuPercent) / 100)
        : 0;

  return {
    pid: metric.pid,
    ppid: 0,
    startTimeMs: metric.creationTimeMs,
    runTimeMs: Math.max(0, sampledAtMs - metric.creationTimeMs),
    name: metric.name ?? metric.serviceName ?? metric.type,
    command: metric.name ?? metric.serviceName ?? metric.type,
    status: "Running",
    cpuPercent: metric.cpuPercent,
    cpuTimeMs,
    residentBytes: metric.workingSetBytes,
    virtualBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioSemantics: "storage",
  };
}

export function processDepths(
  processes: ReadonlyArray<ResourceMonitorProcessSample>,
  roots: ReadonlySet<number>,
): ReadonlyMap<number, number> {
  const childrenByParent = new Map<number, number[]>();

  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process.pid);
    childrenByParent.set(process.ppid, children);
  }

  const depths = new Map<number, number>();
  const queue = [...roots].map((pid) => ({ pid, depth: 0 }));

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || depths.has(current.pid)) continue;
    depths.set(current.pid, current.depth);

    for (const childPid of childrenByParent.get(current.pid) ?? []) {
      queue.push({ pid: childPid, depth: current.depth + 1 });
    }
  }

  return depths;
}

export function isElectronDescendant(
  pid: number,
  processesByPid: ReadonlyMap<number, ResourceMonitorProcessSample>,
  electronPids: ReadonlySet<number>,
): boolean {
  const visited = new Set<number>();
  let currentPid = pid;

  while (!visited.has(currentPid)) {
    visited.add(currentPid);

    if (electronPids.has(currentPid)) return true;
    const current = processesByPid.get(currentPid);

    if (!current || current.ppid <= 0 || current.ppid === currentPid) return false;
    currentPid = current.ppid;
  }

  return false;
}

export function hasElectronAncestor(
  process: ResourceMonitorProcessSample,
  processesByPid: ReadonlyMap<number, ResourceMonitorProcessSample>,
  electronPids: ReadonlySet<number>,
): boolean {
  const visited = new Set<number>();
  let currentPid = process.ppid;

  while (currentPid > 0 && !visited.has(currentPid)) {
    visited.add(currentPid);

    if (electronPids.has(currentPid)) return true;
    const current = processesByPid.get(currentPid);

    if (!current || current.ppid === currentPid) return false;
    currentPid = current.ppid;
  }

  return false;
}

export function orderProcessTree(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  rootPids: ReadonlyArray<number>,
): ReadonlyArray<ResourceTelemetryProcess> {
  const processesByPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const childrenByParent = new Map<number, ResourceTelemetryProcess[]>();

  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process);
    childrenByParent.set(process.ppid, children);
  }

  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.identity.pid - right.identity.pid);
  }

  const ordered: ResourceTelemetryProcess[] = [];
  const visited = new Set<number>();

  const visit = (process: ResourceTelemetryProcess): void => {
    if (visited.has(process.identity.pid)) return;
    visited.add(process.identity.pid);
    ordered.push(process);

    for (const child of childrenByParent.get(process.identity.pid) ?? []) {
      visit(child);
    }
  };

  for (const rootPid of rootPids) {
    const root = processesByPid.get(rootPid);

    if (root) visit(root);
  }

  for (const process of processes.toSorted(
    (left, right) => left.depth - right.depth || left.identity.pid - right.identity.pid,
  )) {
    visit(process);
  }

  return ordered;
}
