import type { ResourceTelemetryProcess } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { formatBytes as formatDiagnosticsBytes } from "./DiagnosticsPresentation";
import { canSignalProcess } from "./ResourceTelemetryProcessTables";
import { SourceStatusBadge } from "./ResourceTelemetrySummary";
import {
  categoryDotClass,
  formatBytes,
  processIdentityKey,
  sourceStatusTone,
} from "./resourceTelemetryPresentation";

const process: ResourceTelemetryProcess = {
  identity: { pid: 12, startTimeMs: 1_000 },
  ppid: 1,
  childPids: [],
  depth: 1,
  name: "worker",
  command: "worker",
  status: "Running",
  category: "server-child",
  cpuPercent: 0,
  cpuTimeMs: 0,
  residentBytes: 0,
  peakResidentBytes: 0,
  virtualBytes: 0,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  ioReadBytesPerSecond: 0,
  ioWriteBytesPerSecond: 0,
  ioSemantics: "storage",
  runTimeMs: 0,
  firstSeenAt: DateTime.makeUnsafe(0),
  lastSeenAt: DateTime.makeUnsafe(0),
};

describe("resource telemetry presentation", () => {
  it("keeps the separate diagnostics and telemetry byte precision policies", () => {
    expect(formatDiagnosticsBytes(100 * 1_024)).toBe("100.0 KB");
    expect(formatBytes(100 * 1_024)).toBe("100 KB");
    expect(formatDiagnosticsBytes(1.5)).toBe("1.5 B");
    expect(formatBytes(1.5)).toBe("2 B");
  });

  it("retains distinct nominal process category colors", () => {
    expect(categoryDotClass("resource-monitor")).toBe("bg-telemetry-monitor");
    expect(categoryDotClass("electron-renderer")).toBe("bg-telemetry-electron");
    expect(categoryDotClass("server")).toBe("bg-telemetry-server");
    expect(categoryDotClass("server-child")).toBe("bg-telemetry-child");
  });

  it("only exposes signals for eligible child, provider, and terminal processes", () => {
    expect(canSignalProcess(process)).toBe(true);
    expect(canSignalProcess({ ...process, category: "provider-root" })).toBe(true);
    expect(canSignalProcess({ ...process, category: "terminal-root" })).toBe(true);
    expect(canSignalProcess({ ...process, category: "server" })).toBe(false);
    expect(canSignalProcess({ ...process, category: "electron-main" })).toBe(false);
    expect(canSignalProcess({ ...process, category: "resource-monitor" })).toBe(false);
  });

  it("distinguishes processes that reuse a PID", () => {
    expect(processIdentityKey(process)).toBe("12:1000");
    expect(processIdentityKey({ ...process, identity: { pid: 12, startTimeMs: 2_000 } })).toBe(
      "12:2000",
    );
  });

  it("preserves source-health labels and the desktop-only presentation", () => {
    expect(sourceStatusTone("healthy")).toBe("default");
    expect(sourceStatusTone("starting")).toBe("warning");
    expect(sourceStatusTone("degraded")).toBe("warning");
    expect(sourceStatusTone("unavailable")).toBe("danger");
    const healthy = renderToStaticMarkup(<SourceStatusBadge label="Native" status="healthy" />);

    const desktop = renderToStaticMarkup(
      <SourceStatusBadge
        label=""
        status="unavailable"
        presentation={{ label: "Desktop only", tone: "neutral" }}
      />,
    );

    expect(healthy).toContain("Native healthy");
    expect(healthy).toContain("border-success/25");
    expect(healthy).toContain("dark:text-success-bright-foreground");
    expect(desktop).toContain("Desktop only");
    expect(desktop).not.toContain("unavailable");
  });
});
