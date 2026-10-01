import type {
  DesktopElectronProcessMetric,
  ResourceMonitorProcessSample,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessCategory,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  MAX_DELTA_INTERVAL_MS,
  ELECTRON_IDENTITY_TOLERANCE_MS,
  type ProcessState,
  type ProcessDelta,
  type MergeProcessesInput,
  type MergeProcessesResult,
  finiteNonNegative,
} from "./ProcessModelTypes.ts";
import {
  processIdentityKey,
  electronCategory,
  inferredElectronCategory,
  matchElectronMetric,
  syntheticNativeSample,
  processDepths,
  isElectronDescendant,
  hasElectronAncestor,
  orderProcessTree,
} from "./ProcessIdentity.ts";
import { categoryGroup, delta, applyLifecycleCounters, aggregate } from "./ProcessCounters.ts";

export function mergeProcesses(input: MergeProcessesInput): MergeProcessesResult {
  const nativeProcesses = Option.match(input.nativeSnapshot, {
    onNone: (): ReadonlyArray<ResourceMonitorProcessSample> => [],
    onSome: (snapshot) => snapshot.processes,
  });

  const electronMetrics = Option.match(input.desktopSnapshot, {
    onNone: (): ReadonlyArray<DesktopElectronProcessMetric> => [],
    onSome: (snapshot) => snapshot.electronProcesses,
  });

  const sampledAtMs = Option.match(input.nativeSnapshot, {
    onNone: () =>
      Option.match(input.desktopSnapshot, {
        onNone: () => input.fallbackSampledAtMs,
        onSome: (snapshot) => snapshot.sampledAtUnixMs,
      }),
    onSome: (native) =>
      Option.match(input.desktopSnapshot, {
        onNone: () => native.sampledAtUnixMs,
        onSome: (desktop) => Math.max(native.sampledAtUnixMs, desktop.sampledAtUnixMs),
      }),
  });

  const nativeSampledAtMs = Option.map(
    input.nativeSnapshot,
    (snapshot) => snapshot.sampledAtUnixMs,
  );

  const desktopSampledAtMs = Option.map(
    input.desktopSnapshot,
    (snapshot) => snapshot.sampledAtUnixMs,
  );

  const nativeProcessPids = new Set(nativeProcesses.map((process) => process.pid));
  const nativeByPid = new Map(nativeProcesses.map((process) => [process.pid, process]));
  const metricsByPid = new Map<number, DesktopElectronProcessMetric>();

  for (const metric of electronMetrics) {
    const nativeProcess = nativeByPid.get(metric.pid);

    if (!nativeProcess) {
      nativeByPid.set(
        metric.pid,
        syntheticNativeSample(
          metric,
          Option.getOrElse(desktopSampledAtMs, () => sampledAtMs),
          input.previous.get(processIdentityKey(metric.pid, metric.creationTimeMs)),
        ),
      );
      metricsByPid.set(metric.pid, metric);
      continue;
    }

    if (
      Math.abs(metric.creationTimeMs - nativeProcess.startTimeMs) <= ELECTRON_IDENTITY_TOLERANCE_MS
    ) {
      metricsByPid.set(metric.pid, metric);
    }
  }

  const processes = [...nativeByPid.values()];
  const processesByPid = new Map(processes.map((process) => [process.pid, process]));
  const requestedElectronRootPids = input.electronRootPids ?? new Set<number>();

  const explicitElectronRootPids = new Set(
    [...requestedElectronRootPids].filter((pid) => {
      const process = processesByPid.get(pid);

      if (!process) return false;
      const expectedStartTime = input.electronRootStartTimes?.get(pid);

      if (expectedStartTime !== undefined) {
        return Math.abs(process.startTimeMs - expectedStartTime) <= ELECTRON_IDENTITY_TOLERANCE_MS;
      }

      if (metricsByPid.has(pid)) return true;

      return [...input.previous.values()].some(
        (previous) =>
          previous.process.category === "electron-main" &&
          previous.process.identity.pid === pid &&
          previous.process.identity.startTimeMs === process.startTimeMs,
      );
    }),
  );

  const electronPids = new Set([...metricsByPid.keys(), ...explicitElectronRootPids]);

  const electronRootPids = [
    ...explicitElectronRootPids,
    ...[...electronPids]
      .filter((pid) => {
        if (explicitElectronRootPids.has(pid)) return false;
        const process = processesByPid.get(pid);

        return process === undefined
          ? true
          : !hasElectronAncestor(process, processesByPid, electronPids);
      })
      .toSorted((left, right) => left - right),
  ].filter((pid, index, values) => values.indexOf(pid) === index);

  const rootPids = [input.serverPid, ...electronRootPids];
  const roots = new Set(rootPids);
  const depths = processDepths(processes, roots);
  const childrenByParent = new Map<number, number[]>();

  for (const process of processes) {
    const children = childrenByParent.get(process.ppid) ?? [];
    children.push(process.pid);
    childrenByParent.set(process.ppid, children);
  }

  const nextPrevious = new Map<string, ProcessState>();
  const processDeltas: ProcessDelta[] = [];

  const normalized = processes.map((process): ResourceTelemetryProcess => {
    const identityKey = processIdentityKey(process.pid, process.startTimeMs);
    const previous = input.previous.get(identityKey);

    const counterSampledAtMs = nativeProcessPids.has(process.pid)
      ? Option.getOrElse(nativeSampledAtMs, () => sampledAtMs)
      : Option.getOrElse(desktopSampledAtMs, () => sampledAtMs);

    const elapsedMs = previous ? counterSampledAtMs - previous.sampledAtMs : 0;

    const cpuTimeDelta = previous
      ? delta({
          current: process.cpuTimeMs,
          previous: previous.process.cpuTimeMs,
          elapsedMs,
        })
      : 0;

    const ioReadDelta = previous
      ? delta({
          current: process.ioReadBytes,
          previous: previous.process.ioReadBytes,
          elapsedMs,
        })
      : 0;

    const ioWriteDelta = previous
      ? delta({
          current: process.ioWriteBytes,
          previous: previous.process.ioWriteBytes,
          elapsedMs,
        })
      : 0;

    const electronMetric = matchElectronMetric(process, metricsByPid);

    const category: ResourceTelemetryProcessCategory =
      process.pid === input.serverPid
        ? "server"
        : Option.contains(input.sidecarPid, process.pid)
          ? "resource-monitor"
          : explicitElectronRootPids.has(process.pid)
            ? "electron-main"
            : electronMetric
              ? electronCategory(electronMetric)
              : isElectronDescendant(process.pid, processesByPid, electronPids)
                ? inferredElectronCategory(process)
                : "server-child";

    const firstSeenAt = previous?.process.firstSeenAt ?? DateTime.makeUnsafe(sampledAtMs);
    const preservePreviousRates = !input.updatePrevious && previous !== undefined;

    const cpuPercent = preservePreviousRates
      ? previous.process.cpuPercent
      : previous && elapsedMs > 0 && elapsedMs <= MAX_DELTA_INTERVAL_MS
        ? (cpuTimeDelta / elapsedMs) * 100
        : finiteNonNegative(process.cpuPercent);

    const normalizedProcess: ResourceTelemetryProcess = {
      identity: {
        pid: process.pid,
        startTimeMs: process.startTimeMs,
      },
      ppid: process.ppid,
      childPids: [...(childrenByParent.get(process.pid) ?? [])].toSorted(
        (left, right) => left - right,
      ),
      depth: depths.get(process.pid) ?? 0,
      name: process.name,
      command: process.command,
      status: process.status,
      category,
      ...(electronMetric ? { electronType: electronMetric.type } : {}),
      ...(electronMetric?.serviceName ? { electronServiceName: electronMetric.serviceName } : {}),
      cpuPercent: finiteNonNegative(cpuPercent),
      cpuTimeMs: process.cpuTimeMs,
      residentBytes: process.residentBytes,
      peakResidentBytes: Math.max(
        process.residentBytes,
        electronMetric?.peakWorkingSetBytes ?? 0,
        previous?.process.peakResidentBytes ?? 0,
      ),
      virtualBytes: process.virtualBytes,
      ioReadBytes: process.ioReadBytes,
      ioWriteBytes: process.ioWriteBytes,
      ioReadBytesPerSecond: preservePreviousRates
        ? previous.process.ioReadBytesPerSecond
        : elapsedMs > 0
          ? finiteNonNegative((ioReadDelta * 1_000) / elapsedMs)
          : 0,
      ioWriteBytesPerSecond: preservePreviousRates
        ? previous.process.ioWriteBytesPerSecond
        : elapsedMs > 0
          ? finiteNonNegative((ioWriteDelta * 1_000) / elapsedMs)
          : 0,
      ioSemantics: process.ioSemantics,
      ...(electronMetric ? { idleWakeupsPerSecond: electronMetric.idleWakeupsPerSecond } : {}),
      runTimeMs: process.runTimeMs,
      firstSeenAt,
      lastSeenAt: DateTime.makeUnsafe(sampledAtMs),
    };

    nextPrevious.set(identityKey, {
      process: normalizedProcess,
      sampledAtMs: counterSampledAtMs,
    });
    processDeltas.push({
      identityKey,
      category,
      cpuTimeMs: cpuTimeDelta,
      ioReadBytes: ioReadDelta,
      ioWriteBytes: ioWriteDelta,
    });

    return normalizedProcess;
  });

  const ordered = orderProcessTree(normalized, rootPids);

  const counters = input.updatePrevious
    ? applyLifecycleCounters({
        counters: input.counters,
        deltas: processDeltas,
        current: nextPrevious,
        previous: input.previous,
      })
    : input.counters;

  const backendProcesses = ordered.filter(
    (process) => categoryGroup(process.category) === "backend",
  );

  const electronProcesses = ordered.filter(
    (process) => categoryGroup(process.category) === "electron",
  );

  const monitorProcesses = ordered.filter(
    (process) => categoryGroup(process.category) === "monitor",
  );

  return {
    sampledAtMs,
    processes: ordered,
    previous: input.updatePrevious ? nextPrevious : input.previous,
    counters,
    groups: {
      backend: aggregate(backendProcesses, counters.backend),
      electron: aggregate(electronProcesses, counters.electron),
      monitor: aggregate(monitorProcesses, counters.monitor),
      allT3: aggregate(ordered, counters.allT3),
    },
    deltas: processDeltas,
  };
}

export type { ProcessState } from "./ProcessModelTypes.ts";

export type { GroupCounters } from "./ProcessModelTypes.ts";

export type { TelemetryCounters } from "./ProcessModelTypes.ts";

export type { ProcessDelta } from "./ProcessModelTypes.ts";

export type { MergeProcessesInput } from "./ProcessModelTypes.ts";

export type { MergeProcessesResult } from "./ProcessModelTypes.ts";

export { emptyGroupCounters } from "./ProcessCounters.ts";

export { emptyTelemetryCounters } from "./ProcessCounters.ts";

export { processIdentityKey } from "./ProcessIdentity.ts";
