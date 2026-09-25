// @effect-diagnostics globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";

import { BOOT_SERVICE_UNIT_FILE } from "../cloud/bootService.ts";
import { runRemoteDoctor, writeRemoteSupportBundle } from "./diagnostics.ts";

describe("Akeru Remote diagnostics", () => {
  it("repairs a fresh container without an update token", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-container-repair-"));
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    const prior = process.env.AKERU_REMOTE_CONTAINER;
    process.env.AKERU_REMOTE_CONTAINER = "1";
    try {
      await expect(
        runRemoteDoctor({ baseDir, repair: true, platform: "linux" }),
      ).resolves.toBeDefined();
    } finally {
      if (prior === undefined) delete process.env.AKERU_REMOTE_CONTAINER;
      else process.env.AKERU_REMOTE_CONTAINER = prior;
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reports a healthy Compose container without systemd or launcher state", async () => {
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
      const report = await runRemoteDoctor({ baseDir, repair: false, platform: "linux" });
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

  it("probes a Windows server over HTTP instead of systemd", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-win32-doctor-"));
    const binDir = NodePath.join(baseDir, "bin");
    NodeFS.mkdirSync(NodePath.join(baseDir, "userdata"), { recursive: true });
    NodeFS.mkdirSync(binDir);
    NodeFS.writeFileSync(
      NodePath.join(baseDir, "userdata", "server-runtime.json"),
      JSON.stringify({ port: 4555 }),
    );
    const probed = NodePath.join(baseDir, "probed");
    NodeFS.writeFileSync(NodePath.join(binDir, "curl"), `#!/bin/sh\necho "$@" > "${probed}"\n`, {
      mode: 0o755,
    });
    NodeFS.writeFileSync(NodePath.join(binDir, "systemctl"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const priorContainer = process.env.AKERU_REMOTE_CONTAINER;
    const priorPath = process.env.PATH;
    const priorPort = process.env.T3CODE_PORT;
    delete process.env.AKERU_REMOTE_CONTAINER;
    delete process.env.T3CODE_PORT;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    try {
      const report = await runRemoteDoctor({ baseDir, repair: false, platform: "win32" });
      expect(report.checks.find((check) => check.id === "service")).toMatchObject({
        status: "pass",
        message: "Akeru server answers its HTTP health check.",
      });
      expect(NodeFS.readFileSync(probed, "utf8")).toContain(
        "http://127.0.0.1:4555/.well-known/t3/environment",
      );
    } finally {
      if (priorContainer !== undefined) process.env.AKERU_REMOTE_CONTAINER = priorContainer;
      if (priorPort !== undefined) process.env.T3CODE_PORT = priorPort;
      process.env.PATH = priorPath;
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reports storage health and repairs private binding permissions", async () => {
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

    const report = await runRemoteDoctor({
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

  it("formats free disk space for people", async () => {
    const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "akeru-disk-format-"));
    const stateDir = Path.join(baseDir, "userdata");
    FS.mkdirSync(stateDir, { recursive: true });
    const report = await runRemoteDoctor({ baseDir, repair: false });
    const disk = report.checks.find((check) => check.id === "disk");
    expect(disk?.message).toMatch(/\d+(\.\d+)? (B|KB|MB|GB|TB) available\./);
    expect(disk?.message).not.toContain("MiB");
    FS.rmSync(baseDir, { recursive: true, force: true });
  });

  it("reports a missing optional account link as pass", async () => {
    const baseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "akeru-binding-optional-"));
    const stateDir = Path.join(baseDir, "userdata");
    FS.mkdirSync(stateDir, { recursive: true });
    const report = await runRemoteDoctor({ baseDir, repair: false });
    const binding = report.checks.find((check) => check.id === "account-binding");
    expect(binding).toMatchObject({ status: "pass" });
    expect(binding?.message).toContain("not configured");
    FS.rmSync(baseDir, { recursive: true, force: true });
  });

  it("reports a fresh home as not created yet instead of raw file errors", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-fresh-home-"));
    const prior = process.env.AKERU_REMOTE_CONTAINER;
    delete process.env.AKERU_REMOTE_CONTAINER;
    try {
      const report = await runRemoteDoctor({ baseDir, repair: false });
      const disk = report.checks.find((check) => check.id === "disk");
      const updateState = report.checks.find((check) => check.id === "update-state");
      expect(disk).toMatchObject({ status: "warning" });
      expect(disk?.message).toContain("not been created yet");
      expect(updateState).toMatchObject({ status: "warning" });
      expect(updateState?.message).toContain("not been created yet");
      expect(JSON.stringify(report.checks)).not.toContain("ENOENT");
      const providers = report.checks.find((check) => check.id === "providers");
      expect(providers?.message).toContain("Kimi For Coding");
      expect(providers?.details?.inServer).toBe("kimi,opencodeGo");
    } finally {
      if (prior !== undefined) process.env.AKERU_REMOTE_CONTAINER = prior;
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("repairs only the checks it was asked to repair", async () => {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-selective-repair-"));
    const stateDir = NodePath.join(baseDir, "userdata");
    NodeFS.mkdirSync(stateDir, { recursive: true });
    const bindingPath = NodePath.join(stateDir, "remote-directory.json");
    NodeFS.writeFileSync(bindingPath, JSON.stringify({ endpointKind: "custom-https" }), {
      mode: 0o644,
    });
    const prior = process.env.AKERU_REMOTE_CONTAINER;
    process.env.AKERU_REMOTE_CONTAINER = "1";
    try {
      const untouched = await runRemoteDoctor({ baseDir, repair: new Set(["logs"]) });
      expect(untouched.repairsApplied).not.toContain("binding-permissions");
      expect(NodeFS.statSync(bindingPath).mode & 0o077).not.toBe(0);

      const repaired = await runRemoteDoctor({
        baseDir,
        repair: new Set(["binding-permissions"]),
      });
      expect(repaired.repairsApplied).toEqual(["binding-permissions"]);
      expect(NodeFS.statSync(bindingPath).mode & 0o077).toBe(0);
    } finally {
      if (prior === undefined) delete process.env.AKERU_REMOTE_CONTAINER;
      else process.env.AKERU_REMOTE_CONTAINER = prior;
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("names the systemd unit that `akeru service install` writes in every remote script", () => {
    // The installer health check and `akeru remote logs` query systemd by name. A stale name makes
    // them silently miss the running service.
    const scripts = ["install-remote.sh", "akeru-remote-admin.sh"].map((name) =>
      NodeFS.readFileSync(new URL(`../../../../scripts/${name}`, import.meta.url), "utf8"),
    );
    for (const script of scripts) {
      expect(script).toContain(BOOT_SERVICE_UNIT_FILE);
      expect(script).not.toContain("akeru.service");
    }
  });
});
