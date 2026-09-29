// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import {
  RemoteDoctorReport,
  type RemoteDiagnosticCheck,
  type RemoteDoctorReport as RemoteDoctorReportValue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { BOOT_SERVICE_LAUNCHD_LABEL, BOOT_SERVICE_UNIT_FILE } from "../cloud/bootService.ts";

const decodeReport = Schema.decodeUnknownSync(RemoteDoctorReport);

const commandOk = (command: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.spawnSync(command, args, { stdio: "ignore" }).status === 0;

const check = (
  id: string,
  status: RemoteDiagnosticCheck["status"],
  message: string,
  repairable = false,
  details?: Record<string, string>,
): RemoteDiagnosticCheck => ({ id, status, message, repairable, ...(details ? { details } : {}) });

function httpsOrigin(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [REDACTED]")
    .replace(/("(?:credential|token|secret)"\s*:\s*")[^"]+/giu, "$1[REDACTED]");
}

export function runRemoteDoctor(input: {
  readonly baseDir: string;
  readonly repair: boolean;
  readonly platform: NodeJS.Platform;
  readonly now?: Date;
}): RemoteDoctorReportValue {
  const stateDir = NodePath.join(input.baseDir, "userdata");
  const bindingPath = NodePath.join(stateDir, "remote-directory.json");
  const dbPath = NodePath.join(stateDir, "state.sqlite");
  const runtimeStatePath = NodePath.join(input.baseDir, "runtime", "service-state.json");
  const logPath = NodePath.join(stateDir, "logs", "boot-service.log");
  const controlTokenPath = NodePath.join(stateDir, "remote-control-token");
  const updateDeferredPath = NodePath.join(stateDir, "remote-update-deferred-at");
  const checks: Array<RemoteDiagnosticCheck> = [];
  const repairsApplied: Array<string> = [];
  const container = process.env.AKERU_REMOTE_CONTAINER === "1";

  const serviceHealthy = container
    ? commandOk("curl", [
        "-fsS",
        `http://127.0.0.1:${process.env.T3CODE_PORT?.trim() || "3773"}/.well-known/t3/environment`,
      ])
    : input.platform === "darwin"
      ? commandOk("launchctl", [
          "print",
          `gui/${process.getuid?.() ?? 0}/${BOOT_SERVICE_LAUNCHD_LABEL}`,
        ])
      : commandOk("systemctl", ["--user", "is-active", BOOT_SERVICE_UNIT_FILE]);
  checks.push(
    check(
      "service",
      serviceHealthy ? "pass" : "fail",
      container
        ? serviceHealthy
          ? "Container HTTP health check passed."
          : "Container HTTP health check failed."
        : serviceHealthy
          ? "Background service is active."
          : "Background service is not active.",
    ),
  );
  if (!container && commandOk("sh", ["-c", "command -v loginctl"])) {
    const linger = NodeChildProcess.spawnSync(
      "loginctl",
      ["show-user", process.env.USER ?? "", "-p", "Linger", "--value"],
      { encoding: "utf8" },
    );
    const persistent = linger.status === 0 && linger.stdout.trim() === "yes";
    checks.push(
      check(
        "boot-persistence",
        persistent ? "pass" : "fail",
        persistent
          ? "The user service starts before login after reboot."
          : "systemd user lingering is disabled; rerun the installer.",
      ),
    );
  }

  try {
    const disk = NodeFS.statfsSync(stateDir);
    const freeBytes = Number(disk.bavail) * Number(disk.bsize);
    checks.push(
      check(
        "disk",
        freeBytes >= 512 * 1024 * 1024 ? "pass" : "fail",
        `${String(Math.floor(freeBytes / 1024 / 1024))} MiB available.`,
        false,
        { freeBytes: String(freeBytes) },
      ),
    );
  } catch (cause) {
    checks.push(check("disk", "fail", `Could not inspect Akeru storage: ${String(cause)}`));
  }

  if (NodeFS.existsSync(dbPath)) {
    try {
      const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      const result = db.prepare("PRAGMA quick_check").get() as Record<string, unknown>;
      db.close();
      const healthy = Object.values(result)[0] === "ok";
      checks.push(
        check(
          "database",
          healthy ? "pass" : "fail",
          healthy ? "SQLite quick check passed." : "SQLite quick check reported damage.",
        ),
      );
    } catch (cause) {
      checks.push(check("database", "fail", `SQLite quick check failed: ${String(cause)}`));
    }
  } else {
    checks.push(check("database", "warning", "Database has not been created yet."));
  }

  let binding: Record<string, unknown> | undefined;
  if (NodeFS.existsSync(bindingPath)) {
    try {
      if (input.repair && (NodeFS.statSync(bindingPath).mode & 0o077) !== 0) {
        NodeFS.chmodSync(bindingPath, 0o600);
        repairsApplied.push("binding-permissions");
      }
      binding = JSON.parse(NodeFS.readFileSync(bindingPath, "utf8")) as Record<string, unknown>;
      const secure = (NodeFS.statSync(bindingPath).mode & 0o077) === 0;
      checks.push(
        check(
          "binding-permissions",
          secure ? "pass" : "fail",
          secure
            ? "Account binding is private to this user."
            : "Account binding permissions are too broad.",
          !secure,
        ),
      );
      const ageMs = (input.now ?? new Date()).getTime() - NodeFS.statSync(bindingPath).mtimeMs;
      checks.push(
        check(
          "directory-heartbeat",
          ageMs < 10 * 60_000 ? "pass" : "warning",
          ageMs < 10 * 60_000
            ? "Directory binding is recent."
            : "Directory heartbeat may be stale.",
          true,
          { ageMs: String(Math.max(0, Math.floor(ageMs))) },
        ),
      );
    } catch (cause) {
      checks.push(
        check("account-binding", "fail", `Account binding is unreadable: ${String(cause)}`),
      );
    }
  } else {
    checks.push(check("account-binding", "warning", "Optional account link is not configured."));
  }

  if (!container && input.repair && !NodeFS.existsSync(controlTokenPath)) {
    NodeFS.writeFileSync(
      controlTokenPath,
      `${NodeCrypto.randomBytes(32).toString("base64url")}\n`,
      {
        mode: 0o600,
      },
    );
    repairsApplied.push("update-credential");
  } else if (
    !container &&
    input.repair &&
    NodeFS.existsSync(controlTokenPath) &&
    (NodeFS.statSync(controlTokenPath).mode & 0o077) !== 0
  ) {
    NodeFS.chmodSync(controlTokenPath, 0o600);
    repairsApplied.push("update-credential-permissions");
  }
  if (!container) {
    const updateCredentialSecure =
      NodeFS.existsSync(controlTokenPath) && (NodeFS.statSync(controlTokenPath).mode & 0o077) === 0;
    checks.push(
      check(
        "update-credential",
        updateCredentialSecure ? "pass" : "fail",
        updateCredentialSecure
          ? "The local update credential is private."
          : "The local update credential is missing or has broad permissions.",
        true,
      ),
    );
  }

  const environmentId = NodeFS.existsSync(NodePath.join(stateDir, "environment-id"))
    ? NodeFS.readFileSync(NodePath.join(stateDir, "environment-id"), "utf8").trim()
    : "";
  // The binding is local state, so only probe an HTTPS origin and never follow redirects.
  const endpointOrigin =
    typeof binding?.endpoint === "string" ? httpsOrigin(binding.endpoint) : undefined;
  if (typeof binding?.endpoint === "string") {
    const response = endpointOrigin
      ? NodeChildProcess.spawnSync(
          "curl",
          ["-fsS", "--proto", "=https", `${endpointOrigin}/.well-known/t3/environment`],
          { encoding: "utf8" },
        )
      : { status: 1, stdout: "" };
    let servedId = "";
    try {
      servedId = String(
        (JSON.parse(response.stdout || "{}") as { environmentId?: unknown }).environmentId ?? "",
      );
    } catch {
      servedId = "";
    }
    checks.push(
      check(
        "endpoint-reachability",
        response.status === 0 && servedId === environmentId ? "pass" : "fail",
        response.status === 0 && servedId === environmentId
          ? "The advertised endpoint reaches this environment."
          : "The advertised endpoint does not reach this environment.",
      ),
    );
  }
  if (binding?.endpointKind === "tailscale" && typeof binding.endpoint === "string") {
    const tailscaleHealthy = commandOk("tailscale", ["status"]);
    checks.push(
      check(
        "tailscale",
        tailscaleHealthy ? "pass" : "fail",
        tailscaleHealthy ? "Tailscale is connected." : "Tailscale is unavailable.",
      ),
    );
    const mapping = binding.tailscaleServe as
      | { httpsPort?: unknown; endpoint?: unknown }
      | undefined;
    const owned = mapping?.httpsPort === 443 && mapping.endpoint === binding.endpoint;
    checks.push(
      check(
        "serve-ownership",
        owned ? "pass" : "fail",
        owned
          ? "The persisted Tailscale Serve mapping belongs to this environment."
          : "The linked Tailscale mapping has no valid ownership record.",
        false,
      ),
    );
  }

  if (container) {
    checks.push(
      check(
        "image-lifecycle",
        "pass",
        "Docker Compose manages image updates and paired data-snapshot rollback.",
      ),
    );
  } else
    try {
      const state = JSON.parse(NodeFS.readFileSync(runtimeStatePath, "utf8")) as {
        activeVersion?: string;
        update?: { status?: string };
      };
      const pending = state.update?.status === "pending";
      checks.push(
        check(
          "update-state",
          pending ? "warning" : "pass",
          pending
            ? "A transactional update is pending."
            : `Runtime ${state.activeVersion ?? "unknown"} has no pending update.`,
          false,
          {
            activeVersion: state.activeVersion ?? "unknown",
            updateStatus: state.update?.status ?? "none",
          },
        ),
      );
    } catch (cause) {
      checks.push(
        check("update-state", "fail", `Service runtime state is unreadable: ${String(cause)}`),
      );
    }
  if (!container && NodeFS.existsSync(updateDeferredPath)) {
    const deferredAt = Date.parse(NodeFS.readFileSync(updateDeferredPath, "utf8").trim());
    const ageMs = (input.now ?? new Date()).getTime() - deferredAt;
    checks.push(
      check(
        "update-deferral",
        ageMs <= 24 * 60 * 60_000 ? "warning" : "fail",
        ageMs <= 24 * 60 * 60_000
          ? "An update is waiting for active bot work to finish."
          : "An update has exceeded the 24 hour maintenance deadline.",
        false,
        { ageMs: String(ageMs) },
      ),
    );
  } else {
    checks.push(check("update-deferral", "pass", "No update is deferred by active work."));
  }
  const releaseRoot = process.env.AKERU_REMOTE_RELEASE_ROOT;
  if (releaseRoot) {
    const previous = NodePath.join(releaseRoot, "previous");
    checks.push(
      check(
        "rollback-runtime",
        NodeFS.existsSync(previous) ? "pass" : "warning",
        NodeFS.existsSync(previous)
          ? "A previous runtime is available for rollback."
          : "No previous runtime is available yet.",
      ),
    );
  }

  const providers = ["codex", "claude", "grok", "opencode", "kimi"].filter((name) =>
    commandOk("sh", ["-c", `command -v ${name}`]),
  );
  checks.push(
    check(
      "providers",
      providers.length > 0 ? "pass" : "warning",
      providers.length > 0
        ? `Available providers: ${providers.join(", ")}.`
        : "No provider command was found on PATH.",
      false,
      { available: providers.join(",") },
    ),
  );

  if (input.repair) {
    NodeFS.mkdirSync(NodePath.dirname(logPath), { recursive: true, mode: 0o700 });
    repairsApplied.push("log-directory");
  }
  let logBytes = NodeFS.existsSync(logPath) ? NodeFS.statSync(logPath).size : 0;
  if (input.repair && logBytes >= 100 * 1024 * 1024) {
    NodeFS.renameSync(logPath, `${logPath}.previous`);
    NodeFS.writeFileSync(logPath, "", { mode: 0o600 });
    logBytes = 0;
    repairsApplied.push("log-rotation");
  }
  checks.push(
    check(
      "logs",
      logBytes < 100 * 1024 * 1024 ? "pass" : "warning",
      `${String(logBytes)} bytes in the boot service log.`,
      false,
      { bytes: String(logBytes) },
    ),
  );

  const overall = checks.some((entry) => entry.status === "fail")
    ? "fail"
    : checks.some((entry) => entry.status === "warning")
      ? "warning"
      : "pass";
  return decodeReport({
    version: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    overall,
    checks,
    repairsApplied,
  });
}

export function renderRemoteDoctor(report: RemoteDoctorReportValue): string {
  return [
    `Akeru Remote doctor: ${report.overall}`,
    ...report.checks.map((entry) => `  ${entry.status.padEnd(7)} ${entry.id}: ${entry.message}`),
    ...(report.repairsApplied.length > 0
      ? [`  repaired: ${report.repairsApplied.join(", ")}`]
      : []),
  ].join("\n");
}

export function writeRemoteSupportBundle(
  path: string,
  report: RemoteDoctorReportValue,
  host: { readonly platform: NodeJS.Platform; readonly arch: NodeJS.Architecture },
): void {
  NodeFS.writeFileSync(path, redact(`${JSON.stringify({ report, ...host }, null, 2)}\n`), {
    mode: 0o600,
  });
  // `mode` applies only on creation; an existing bundle keeps its old permissions otherwise.
  NodeFS.chmodSync(path, 0o600);
}
