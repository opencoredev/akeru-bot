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

describe("resource telemetry process model", () => {
  it("derives cumulative CPU time for synthetic Electron-only processes", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
      ]),
      desktop: desktopSnapshot(BASE_TIME_MS, [
        electronMetric({
          pid: 300,
          creationTimeMs: 10_000,
          type: "Browser",
          cpuPercent: 50,
        }),
      ]),
    });

    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 })],
        2,
      ),
      desktop: desktopSnapshot(BASE_TIME_MS + 1_000, [
        electronMetric({
          pid: 300,
          creationTimeMs: 10_000,
          type: "Browser",
          cpuPercent: 50,
        }),
      ]),
    });

    expect(second.processes.find((process) => process.identity.pid === 300)?.cpuTimeMs).toBe(500);
    expect(second.groups.electron.cpuTimeMs).toBe(500);
  });

  it("uses the native timestamp for native cumulative-counter deltas", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({
          pid: SERVER_PID,
          ppid: 1,
          startTimeMs: 1_000,
          cpuTimeMs: 1_000,
        }),
      ]),
      desktop: desktopSnapshot(BASE_TIME_MS + 10_000, []),
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
            cpuTimeMs: 1_500,
          }),
        ],
        2,
      ),
      desktop: desktopSnapshot(BASE_TIME_MS + 11_000, []),
    });

    expect(second.processes[0]?.cpuPercent).toBe(50);
    expect(second.groups.backend.cpuTimeMs).toBe(500);
  });

  it("derives rates from cumulative counters and preserves I/O semantics", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({
          pid: SERVER_PID,
          ppid: 1,
          startTimeMs: 1_000,
          cpuTimeMs: 1_000,
          ioReadBytes: 10_000,
          ioWriteBytes: 20_000,
          ioSemantics: "all-io",
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
            ioSemantics: "all-io",
          }),
        ],
        2,
      ),
    });

    const server = second.processes[0]!;

    expect(server.cpuPercent).toBe(25);
    expect(server.ioReadBytesPerSecond).toBe(2_000);
    expect(server.ioWriteBytesPerSecond).toBe(3_000);
    expect(server.ioSemantics).toBe("all-io");
    expect(second.groups.backend.cpuTimeMs).toBe(250);
    expect(second.groups.backend.ioReadBytes).toBe(2_000);
    expect(second.groups.backend.ioWriteBytes).toBe(3_000);
  });

  it("derives deltas at the constrained 15-second sampling cadence", () => {
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
        BASE_TIME_MS + 15_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 2_500,
            ioReadBytes: 25_000,
            ioWriteBytes: 50_000,
          }),
        ],
        2,
      ),
    });

    expect(second.processes[0]?.cpuPercent).toBe(10);
    expect(second.processes[0]?.ioReadBytesPerSecond).toBe(1_000);
    expect(second.processes[0]?.ioWriteBytesPerSecond).toBe(2_000);
    expect(second.groups.backend.cpuTimeMs).toBe(1_500);
    expect(second.groups.backend.ioReadBytes).toBe(15_000);
    expect(second.groups.backend.ioWriteBytes).toBe(30_000);
  });

  it("resets deltas when counters decrease or the sampling gap is unsafe", () => {
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

    const decreased = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 100,
            ioReadBytes: 100,
            ioWriteBytes: 200,
          }),
        ],
        2,
      ),
    });

    const delayed = merge({
      previous: decreased,
      native: nativeSnapshot(
        BASE_TIME_MS + 90_000,
        [
          processSample({
            pid: SERVER_PID,
            ppid: 1,
            startTimeMs: 1_000,
            cpuTimeMs: 10_000,
            ioReadBytes: 100_000,
            ioWriteBytes: 200_000,
          }),
        ],
        3,
      ),
    });

    expect(decreased.processes[0]?.cpuPercent).toBe(0);
    expect(decreased.processes[0]?.ioReadBytesPerSecond).toBe(0);
    expect(decreased.processes[0]?.ioWriteBytesPerSecond).toBe(0);
    expect(delayed.processes[0]?.cpuPercent).toBe(0);
    expect(delayed.processes[0]?.ioReadBytesPerSecond).toBe(0);
    expect(delayed.processes[0]?.ioWriteBytesPerSecond).toBe(0);
    expect(delayed.groups.backend.cpuTimeMs).toBe(0);
    expect(delayed.groups.backend.ioReadBytes).toBe(0);
    expect(delayed.groups.backend.ioWriteBytes).toBe(0);
  });

  it("treats reused PIDs as an exit plus a new process", () => {
    const first = merge({
      native: nativeSnapshot(BASE_TIME_MS, [
        processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
        processSample({ pid: 200, ppid: SERVER_PID, startTimeMs: 2_000 }),
      ]),
    });

    const second = merge({
      previous: first,
      native: nativeSnapshot(
        BASE_TIME_MS + 1_000,
        [
          processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 1_000 }),
          processSample({
            pid: 200,
            ppid: SERVER_PID,
            startTimeMs: 9_000,
            cpuTimeMs: 999,
            ioReadBytes: 999,
            ioWriteBytes: 999,
          }),
        ],
        2,
      ),
    });

    const reused = second.processes.find((process) => process.identity.pid === 200)!;

    expect(reused.identity.startTimeMs).toBe(9_000);
    expect(reused.cpuPercent).toBe(0);
    expect(reused.ioReadBytesPerSecond).toBe(0);
    expect(second.groups.backend.processStarts).toBe(3);
    expect(second.groups.backend.processExits).toBe(1);
  });
});
