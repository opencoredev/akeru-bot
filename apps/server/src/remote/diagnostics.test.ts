// @effect-diagnostics globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { runRemoteDoctor, writeRemoteSupportBundle } from "./diagnostics.ts";

describe("Akeru Remote diagnostics", () => {
  it("repairs a fresh container without an update token", () => {
    const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "akeru-container-repair-"));
    FS.mkdirSync(Path.join(baseDir, "userdata"), { recursive: true });
    const prior = process.env.AKERU_REMOTE_CONTAINER;
    process.env.AKERU_REMOTE_CONTAINER = "1";
    try {
      expect(() => runRemoteDoctor({ baseDir, repair: true })).not.toThrow();
    } finally {
      if (prior === undefined) delete process.env.AKERU_REMOTE_CONTAINER;
      else process.env.AKERU_REMOTE_CONTAINER = prior;
      FS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reports a healthy Compose container without systemd or launcher state", () => {
    const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "akeru-container-doctor-"));
    const binDir = Path.join(baseDir, "bin");
    FS.mkdirSync(Path.join(baseDir, "userdata"), { recursive: true });
    FS.mkdirSync(binDir);
    FS.writeFileSync(Path.join(binDir, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const priorContainer = process.env.AKERU_REMOTE_CONTAINER;
    const priorPath = process.env.PATH;
    process.env.AKERU_REMOTE_CONTAINER = "1";
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    try {
      const report = runRemoteDoctor({ baseDir, repair: false });
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
      FS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reports storage health and repairs private binding permissions", () => {
    const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "akeru-doctor-"));
    const stateDir = Path.join(baseDir, "userdata");
    FS.mkdirSync(Path.join(baseDir, "runtime"), { recursive: true });
    FS.mkdirSync(stateDir, { recursive: true });
    const db = new DatabaseSync(Path.join(stateDir, "state.sqlite"));
    db.exec("CREATE TABLE health(value TEXT)");
    db.close();
    const bindingPath = Path.join(stateDir, "remote-directory.json");
    FS.writeFileSync(
      bindingPath,
      JSON.stringify({
        endpointKind: "custom-https",
        credential: "super-secret",
        accountId: "acct-1",
        linkGeneration: "generation-1",
      }),
      { mode: 0o644 },
    );
    FS.writeFileSync(
      Path.join(baseDir, "runtime", "service-state.json"),
      JSON.stringify({ activeVersion: "1.2.3", update: { status: "idle" } }),
    );

    const report = runRemoteDoctor({
      baseDir,
      repair: true,
      now: new Date("2026-09-13T12:00:00.000Z"),
    });
    expect(report.checks.find((check) => check.id === "database")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "binding-permissions")?.status).toBe("pass");
    expect(report.repairsApplied).toContain("binding-permissions");
    expect(FS.statSync(bindingPath).mode & 0o077).toBe(0);

    const bundlePath = Path.join(baseDir, "support.json");
    writeRemoteSupportBundle(bundlePath, report);
    expect(FS.statSync(bundlePath).mode & 0o077).toBe(0);
    expect(FS.readFileSync(bundlePath, "utf8")).not.toContain("super-secret");
    FS.rmSync(baseDir, { recursive: true, force: true });
  });
});
