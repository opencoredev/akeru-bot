// @effect-diagnostics globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { runRemoteDoctor, writeRemoteSupportBundle } from "./diagnostics.ts";

describe("Akeru Remote diagnostics", () => {
  it("repairs a fresh container without an update token", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-container-repair-"));
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    const prior = process.env.AKERU_REMOTE_CONTAINER;
    process.env.AKERU_REMOTE_CONTAINER = "1";
    try {
      expect(() => runRemoteDoctor({ baseDir, repair: true, platform: "linux" })).not.toThrow();
    } finally {
      if (prior === undefined) delete process.env.AKERU_REMOTE_CONTAINER;
      else process.env.AKERU_REMOTE_CONTAINER = prior;
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reports a healthy Compose container without systemd or launcher state", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-container-doctor-"));
    const binDir = NodePath.join(baseDir, "bin");
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    NodeFS.mkdirSync(binDir);
    NodeFS.writeFileSync(NodePath.join(binDir, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const priorContainer = process.env.AKERU_REMOTE_CONTAINER;
    const priorPath = process.env.PATH;
    process.env.AKERU_REMOTE_CONTAINER = "1";
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    try {
      const report = runRemoteDoctor({ baseDir, repair: false, platform: "linux" });
      expect(report.checks.find((check) => check.id === "service")?.status).toBe("pass");
      expect(report.checks.find((check) => check.id === "image-lifecycle")?.status).toBe("pass");
      expect(report.checks.some((check) => check.id === "boot-persistence")).toBe(false);
      expect(report.checks.some((check) => check.id === "update-credential")).toBe(false);
      expect(report.checks.some((check) => check.id === "update-state")).toBe(false);
      expect(report.overall).not.toBe("fail");
    } finally {
      if (priorContainer === undefined) delete process.env.AKERU_REMOTE_CONTAINER;
      else process.env.AKERU_REMOTE_CONTAINER = priorContainer;
      process.env.PATH = priorPath;
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reports storage health and repairs private binding permissions", () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-doctor-"));
    const stateDir = NodePath.join(baseDir, "userdata");
    NodeFS.mkdirSync(NodePath.join(baseDir, "runtime"), { recursive: true });
    NodeFS.mkdirSync(stateDir, { recursive: true });
    const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "state.sqlite"));
    db.exec("CREATE TABLE health(value TEXT)");
    db.close();
    const bindingPath = NodePath.join(stateDir, "remote-directory.json");
    NodeFS.writeFileSync(
      bindingPath,
      JSON.stringify({
        endpointKind: "custom-https",
        credential: "super-secret",
        accountId: "acct-1",
        linkGeneration: "generation-1",
      }),
      { mode: 0o644 },
    );
    NodeFS.writeFileSync(
      NodePath.join(baseDir, "runtime", "service-state.json"),
      JSON.stringify({ activeVersion: "1.2.3", update: { status: "idle" } }),
    );

    const report = runRemoteDoctor({
      baseDir,
      repair: true,
      platform: "linux",
      now: new Date("2026-09-13T12:00:00.000Z"),
    });
    expect(report.checks.find((check) => check.id === "database")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "binding-permissions")?.status).toBe("pass");
    expect(report.repairsApplied).toContain("binding-permissions");
    expect(NodeFS.statSync(bindingPath).mode & 0o077).toBe(0);

    const bundlePath = NodePath.join(baseDir, "support.json");
    NodeFS.writeFileSync(bundlePath, "old", { mode: 0o644 });
    NodeFS.chmodSync(bundlePath, 0o644);
    writeRemoteSupportBundle(bundlePath, report, { platform: "linux", arch: "x64" });
    expect(NodeFS.statSync(bundlePath).mode & 0o077).toBe(0);
    expect(NodeFS.readFileSync(bundlePath, "utf8")).not.toContain("super-secret");
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  });
});
