import * as Path from "effect/Path";
import {
  BOOT_SERVICE_UNIT_FILE,
  BOOT_SERVICE_UNIT_ENV,
  type BootServicePlan,
  STOP_STEP_TIMEOUT,
  type BootServiceManager,
} from "./bootServiceTypes.ts";
import { escapeXmlText } from "./bootServiceLaunchd.ts";

/** systemd expands `%` specifiers, including in unquoted append-log paths. */
export function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

export function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);

  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

/**
 * A legacy-named unit belongs to this install only when it launches this base
 * dir's service launcher. A T3 Code install points at its own `~/.t3` runtime,
 * so it never matches and is left untouched.
 */
export function isOwnedLegacyBootServiceUnit(contents: string, launcherPath: string): boolean {
  return (
    contents.includes(quoteSystemdValue(launcherPath)) ||
    contents.includes(`<string>${escapeXmlText(launcherPath)}</string>`)
  );
}

/** Pure renderer: service units cannot rely on the user's shell or PATH. */
export function renderBootServiceUnit(plan: BootServicePlan): string {
  // The user manager has no reliable network-online target; server networking retries itself.
  return [
    "[Unit]",
    "Description=Akeru Bot server",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    `Environment=AKERU_HOME=${quoteSystemdValue(plan.baseDir)}`,
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `ExecStart=${quoteSystemdValue(plan.nodePath)} ${quoteSystemdValue(plan.launcherPath)}`,
    // Let the launcher mark an explicit stop before it signals the server.
    // systemd still SIGKILLs the whole cgroup if graceful shutdown times out.
    "KillMode=mixed",
    // Agent tool calls run as children of the server, so they share this cgroup.
    // With the systemd default of OOMPolicy=stop, the kernel killing one greedy
    // child stops the whole unit: the server, every live agent, and the user's
    // connection. Keep running and let Restart=always cover the main process.
    "OOMPolicy=continue",
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function systemdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
  /** Defaults to the current unit name; the legacy name is used only to retire old units. */
  readonly unitFile?: string;
}): BootServiceManager {
  const unitFile = input.unitFile ?? BOOT_SERVICE_UNIT_FILE;
  const unitPath = input.path.join(input.homeDir, ".config", "systemd", "user", unitFile);

  return {
    kind: "systemd",
    unitPath,
    render: renderBootServiceUnit,
    stop: [
      {
        step: "stopping the installed service",
        command: "systemctl",
        args: ["--user", "stop", unitFile],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
      {
        step: "enabling the service",
        command: "systemctl",
        args: ["--user", "enable", unitFile],
      },
      { step: "enabling lingering for this user", command: "loginctl", args: ["enable-linger"] },
      // Start last. No administrative state write occurs after this succeeds.
      {
        step: "starting the service",
        command: "systemctl",
        args: ["--user", "restart", unitFile],
      },
    ],
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "systemctl",
        args: ["--user", "restart", unitFile],
      },
    ],
    deactivate: [
      {
        step: "stopping the service",
        command: "systemctl",
        args: ["--user", "disable", "--now", unitFile],
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [
      {
        step: "reloading systemd user units",
        command: "systemctl",
        args: ["--user", "daemon-reload"],
      },
    ],
  };
}
