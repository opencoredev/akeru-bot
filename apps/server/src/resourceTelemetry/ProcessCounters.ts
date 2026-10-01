import type {
  ResourceTelemetryAggregate,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessCategory,
} from "@akeru/contracts";
import {
  MAX_DELTA_INTERVAL_MS,
  type ProcessState,
  type GroupCounters,
  type TelemetryCounters,
  type ProcessDelta,
} from "./ProcessModelTypes.ts";
export const emptyGroupCounters = (): GroupCounters => ({
  cpuTimeMs: 0,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  processStarts: 0,
  processExits: 0,
});

export const emptyTelemetryCounters = (): TelemetryCounters => ({
  backend: emptyGroupCounters(),
  electron: emptyGroupCounters(),
  monitor: emptyGroupCounters(),
  allT3: emptyGroupCounters(),
});

export function categoryGroup(
  category: ResourceTelemetryProcessCategory,
): "backend" | "electron" | "monitor" {
  if (category === "resource-monitor") return "monitor";
  if (category.startsWith("electron-")) return "electron";
  return "backend";
}

export function delta(input: {
  readonly current: number;
  readonly previous: number;
  readonly elapsedMs: number;
}): number {
  if (
    input.elapsedMs <= 0 ||
    input.elapsedMs > MAX_DELTA_INTERVAL_MS ||
    input.current < input.previous
  ) {
    return 0;
  }
  return input.current - input.previous;
}

export function incrementCounters(
  counters: GroupCounters,
  update: Partial<GroupCounters>,
): GroupCounters {
  return {
    cpuTimeMs: counters.cpuTimeMs + (update.cpuTimeMs ?? 0),
    ioReadBytes: counters.ioReadBytes + (update.ioReadBytes ?? 0),
    ioWriteBytes: counters.ioWriteBytes + (update.ioWriteBytes ?? 0),
    processStarts: counters.processStarts + (update.processStarts ?? 0),
    processExits: counters.processExits + (update.processExits ?? 0),
  };
}

export function applyLifecycleCounters(input: {
  readonly counters: TelemetryCounters;
  readonly deltas: ReadonlyArray<ProcessDelta>;
  readonly current: ReadonlyMap<string, ProcessState>;
  readonly previous: ReadonlyMap<string, ProcessState>;
}): TelemetryCounters {
  let backend = input.counters.backend;
  let electron = input.counters.electron;
  let monitor = input.counters.monitor;
  let allT3 = input.counters.allT3;
  for (const processDelta of input.deltas) {
    const group = categoryGroup(processDelta.category);
    switch (group) {
      case "backend":
        backend = incrementCounters(backend, processDelta);
        break;
      case "electron":
        electron = incrementCounters(electron, processDelta);
        break;
      case "monitor":
        monitor = incrementCounters(monitor, processDelta);
        break;
    }
    allT3 = incrementCounters(allT3, processDelta);
  }

  for (const [identityKey, current] of input.current) {
    if (input.previous.has(identityKey)) continue;
    const group = categoryGroup(current.process.category);
    switch (group) {
      case "backend":
        backend = incrementCounters(backend, { processStarts: 1 });
        break;
      case "electron":
        electron = incrementCounters(electron, { processStarts: 1 });
        break;
      case "monitor":
        monitor = incrementCounters(monitor, { processStarts: 1 });
        break;
    }
    allT3 = incrementCounters(allT3, { processStarts: 1 });
  }

  for (const [identityKey, previous] of input.previous) {
    if (input.current.has(identityKey)) continue;
    const group = categoryGroup(previous.process.category);
    switch (group) {
      case "backend":
        backend = incrementCounters(backend, { processExits: 1 });
        break;
      case "electron":
        electron = incrementCounters(electron, { processExits: 1 });
        break;
      case "monitor":
        monitor = incrementCounters(monitor, { processExits: 1 });
        break;
    }
    allT3 = incrementCounters(allT3, { processExits: 1 });
  }

  return { backend, electron, monitor, allT3 };
}

export function aggregate(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  counters: GroupCounters,
): ResourceTelemetryAggregate {
  return {
    processCount: processes.length,
    currentCpuPercent: processes.reduce((total, process) => total + process.cpuPercent, 0),
    cpuTimeMs: counters.cpuTimeMs,
    currentRssBytes: processes.reduce((total, process) => total + process.residentBytes, 0),
    peakRssBytes: processes.reduce((total, process) => total + process.peakResidentBytes, 0),
    ioReadBytes: counters.ioReadBytes,
    ioWriteBytes: counters.ioWriteBytes,
    ioReadBytesPerSecond: processes.reduce(
      (total, process) => total + process.ioReadBytesPerSecond,
      0,
    ),
    ioWriteBytesPerSecond: processes.reduce(
      (total, process) => total + process.ioWriteBytesPerSecond,
      0,
    ),
    processStarts: counters.processStarts,
    processExits: counters.processExits,
  };
}
