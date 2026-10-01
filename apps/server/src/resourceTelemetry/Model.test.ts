import {
  SERVER_PID,
  BASE_TIME_MS,
  processSample,
  nativeSnapshot,
  electronMetric,
  desktopSnapshot,
  merge,
} from "./testUtils/processModel.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { emptyTelemetryCounters, mergeProcesses } from "./Model.ts";
describe("resource telemetry process model", () => {
  it("builds complete descendant depths and isolates monitor overhead", () => {
    const result = merge({
      sidecarPid: 900,
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
        processSample({ pid: 200, ppid: SERVER_PID, startTimeMs: 2_000 }),
        processSample({ pid: 201, ppid: 200, startTimeMs: 3_000 }),
        processSample({ pid: 202, ppid: 201, startTimeMs: 4_000 }),
        processSample({ pid: 900, ppid: SERVER_PID, startTimeMs: 5_000 }),
      ]),
    });

    expect(result.processes.map((process) => [process.identity.pid, process.depth])).toEqual([
      [100, 0],
      [200, 1],
      [201, 2],
      [202, 3],
      [900, 1],
    ]);
    expect(result.processes.find((process) => process.identity.pid === 900)?.category).toBe(
      "resource-monitor",
    );
    expect(result.groups.backend.processCount).toBe(4);
    expect(result.groups.monitor.processCount).toBe(1);
    expect(result.groups.monitor.processStarts).toBe(1);
    expect(result.groups.allT3.processStarts).toBe(5);
  });

  it("deduplicates Electron metrics and classifies Electron descendants", () => {
    const electronStart = 10_000;
    const result = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
        processSample({ pid: 300, ppid: 1, startTimeMs: electronStart }),
        processSample({ pid: 301, ppid: 300, startTimeMs: electronStart + 1 }),
      ]),
      desktop: desktopSnapshot(BASE_TIME_MS, [
        electronMetric({
          pid: 300,
          creationTimeMs: electronStart + 500,
          type: "Browser",
          name: "electron",
        }),
        electronMetric({
          pid: 301,
          creationTimeMs: electronStart + 500,
          type: "Utility",
          name: "network-service",
        }),
      ]),
    });

    expect(result.processes.filter((process) => process.identity.pid === 300)).toHaveLength(1);
    expect(result.processes.find((process) => process.identity.pid === 300)?.category).toBe(
      "electron-main",
    );
    expect(result.processes.find((process) => process.identity.pid === 301)?.category).toBe(
      "electron-utility",
    );
    expect(result.processes.find((process) => process.identity.pid === 301)?.depth).toBe(1);
    expect(result.groups.electron.processCount).toBe(2);
  });

  it("ignores stale Electron metrics after PID reuse", () => {
    const result = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
        processSample({ pid: 300, ppid: SERVER_PID, startTimeMs: 50_000 }),
      ]),
      desktop: desktopSnapshot(BASE_TIME_MS, [
        electronMetric({
          pid: 300,
          creationTimeMs: 10_000,
          type: "Browser",
        }),
      ]),
    });

    expect(result.processes.find((process) => process.identity.pid === 300)?.category).toBe(
      "server-child",
    );
    expect(result.groups.electron.processCount).toBe(0);
  });

  it("does not advance synthetic CPU time when reusing the same desktop sample", () => {
    const metric = electronMetric({
      pid: 300,
      creationTimeMs: 10_000,
      type: "Browser",
      cpuPercent: 50,
    });
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
      ]),
      desktop: desktopSnapshot(BASE_TIME_MS, [metric]),
    });
    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 })],
        2,
      ),
      desktop: desktopSnapshot(BASE_TIME_MS, [metric]),
    });

    expect(second.processes.find((process) => process.identity.pid === 300)?.cpuTimeMs).toBe(0);
    expect(second.groups.electron.cpuTimeMs).toBe(0);
  });

  it("does not apply an explicit Electron root to a reused PID", () => {
    const first = mergeProcesses({
      serverPid: SERVER_PID,
      sidecarPid: Option.none(),
      electronRootPids: new Set([300]),
      fallbackSampledAtMs: BASE_TIME_MS,
      nativeSnapshot: Option.some(
        nativeSnapshot(BASE_TIME_MS, [
          processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
          processSample({ pid: 300, ppid: 1, startTimeMs: 10_000 }),
        ]),
      ),
      desktopSnapshot: Option.some(
        desktopSnapshot(BASE_TIME_MS, [
          electronMetric({
            pid: 300,
            creationTimeMs: 10_000,
            type: "Browser",
          }),
        ]),
      ),
      previous: new Map(),
      counters: emptyTelemetryCounters(),
      updatePrevious: true,
    });
    const reused = mergeProcesses({
      serverPid: SERVER_PID,
      sidecarPid: Option.none(),
      electronRootPids: new Set([300]),
      fallbackSampledAtMs: BASE_TIME_MS + 1_000,
      nativeSnapshot: Option.some(
        nativeSnapshot(
          BASE_TIME_MS + 1_000,
          [
            processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
            processSample({ pid: 300, ppid: SERVER_PID, startTimeMs: 20_000 }),
          ],
          2,
        ),
      ),
      desktopSnapshot: Option.none(),
      previous: first.previous,
      counters: first.counters,
      updatePrevious: true,
    });

    expect(reused.processes.find((process) => process.identity.pid === 300)?.category).toBe(
      "server-child",
    );
    expect(reused.groups.electron.processCount).toBe(0);
  });

  it("preserves native rates while applying a desktop-only update", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({
          pid: SERVER_PID,
          ppid: 1,
          startTimeMs: 1_000,
          cpuTimeMs: 1_000,
          ioReadBytes: 10_000,
          ioWriteBytes: 20_000,
        }),
      ]),
    });
    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 1_250,
            ioReadBytes: 12_000,
            ioWriteBytes: 23_000,
          }),
        ],
        2,
      ),
    });
    const desktopOnly = mergeProcesses({
      serverPid: SERVER_PID,
      sidecarPid: Option.none(),
      fallbackSampledAtMs: BASE_TIME_MS + 1_000,
      nativeSnapshot: Option.some(
        nativeSnapshot(
          BASE_TIME_MS + 1_000,
          [
            processSample({
              pid: SERVER_PID,
              ppid: 1,
              startTimeMs: 1_000,
              cpuTimeMs: 1_250,
              ioReadBytes: 12_000,
              ioWriteBytes: 23_000,
            }),
          ],
          2,
        ),
      ),
      desktopSnapshot: Option.some(desktopSnapshot(BASE_TIME_MS + 1_500, [])),
      previous: second.previous,
      counters: second.counters,
      updatePrevious: false,
    });

    expect(desktopOnly.processes[0]?.cpuPercent).toBe(25);
    expect(desktopOnly.processes[0]?.ioReadBytesPerSecond).toBe(2_000);
    expect(desktopOnly.processes[0]?.ioWriteBytesPerSecond).toBe(3_000);
    expect(desktopOnly.sampledAtMs).toBe(BASE_TIME_MS + 1_500);
  });
});
