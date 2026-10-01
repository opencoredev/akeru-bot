import * as Path from "effect/Path";
import {
  BOOT_SERVICE_LAUNCHD_LABEL,
  BOOT_SERVICE_PLIST_FILE,
  BOOT_SERVICE_UNIT_ENV,
  type BootServicePlan,
  STOP_STEP_TIMEOUT,
  type BootServiceManager,
} from "./bootServiceTypes.ts";
/** Plist values are emitted as XML text nodes; only these three need escaping. */
export function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Pure renderer: launch agents cannot rely on the user's shell or PATH. */
export function renderBootServicePlist(
  plan: BootServicePlan,
  options: { readonly homeDir: string; readonly environmentPath: string },
): string {
  // KeepAlive + ThrottleInterval mirror Restart=always + RestartSec=5. launchd
  // has no StartLimitBurst analog; a hard crash loop respawns every 5s forever.
  // ExitTimeOut 90 matches systemd's default TimeoutStopSec. A plain stop
  // completes within the launcher's 5s child grace, but a stop that queues
  // behind an in-flight update transition can take much longer; launchd's
  // system-defined default (5s on current macOS) would SIGKILL the launcher
  // (and, with it, the process group) mid-handoff.
  // ProcessType Interactive opts out of background-job resource throttling.
  // AbandonProcessGroup stays at its default (false): launchd reaps leftover
  // process-group members only when the launcher itself exits — the analog of
  // KillMode=mixed's final cgroup kill — and not when the launcher restarts its
  // child, so agent children survive server updates.
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${BOOT_SERVICE_LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${escapeXmlText(plan.nodePath)}</string>`,
    `    <string>${escapeXmlText(plan.launcherPath)}</string>`,
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>PATH</key>`,
    `    <string>${escapeXmlText(options.environmentPath)}</string>`,
    `    <key>AKERU_HOME</key>`,
    `    <string>${escapeXmlText(plan.baseDir)}</string>`,
    `    <key>${BOOT_SERVICE_UNIT_ENV}</key>`,
    `    <string>${BOOT_SERVICE_PLIST_FILE}</string>`,
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXmlText(options.homeDir)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>5</integer>`,
    `  <key>ExitTimeOut</key>`,
    `  <integer>90</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Interactive</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXmlText(plan.logPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export function launchdManager(input: {
  readonly path: Path.Path;
  readonly homeDir: string;
  readonly uid: number;
  readonly environmentPath: string;
  /** Defaults to the current label; the legacy label is used only to retire old agents. */
  readonly label?: string;
}): BootServiceManager {
  const label = input.label ?? BOOT_SERVICE_LAUNCHD_LABEL;
  const unitPath = input.path.join(input.homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const domainTarget = `gui/${input.uid}`;
  const serviceTarget = `${domainTarget}/${label}`;
  // bootout/enable are optional: they fail on not-loaded states that are fine
  // to proceed from. The strict `bootstrap` runs last and is also the start:
  // loading a RunAtLoad/KeepAlive plist starts the job, so a separate
  // kickstart would kill and restart a server it just booted. A lingering job
  // that survived bootout, or a gui domain with nobody logged in at the
  // screen (SSH install), makes bootstrap fail the flow loudly rather than
  // silently keeping a stale server.
  return {
    kind: "launchd",
    unitPath,
    render: (plan) =>
      renderBootServicePlist(plan, {
        homeDir: input.homeDir,
        environmentPath: input.environmentPath,
      }),
    // Without --wait, bootout returns in milliseconds while the job drains
    // for up to ExitTimeOut, and a bootstrap during the drain fails EIO.
    // --wait (present on modern macOS, absent from the man page) blocks until
    // the job is removed from the domain; STOP_STEP_TIMEOUT outlives it.
    stop: [
      {
        step: "stopping the installed launch agent",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    activate: [
      // A persisted `launchctl disable` override refuses bootstrap; clear it.
      {
        step: "enabling the launch agent",
        command: "launchctl",
        args: ["enable", serviceTarget],
        optional: true,
      },
      // Start last. No administrative state write occurs after this succeeds.
      {
        step: "starting the service",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    restart: [
      {
        step: "restarting the service after a failed update",
        command: "launchctl",
        args: ["bootstrap", domainTarget, unitPath],
      },
    ],
    // No `launchctl disable` here: a persisted override would sabotage a
    // later reinstall. Removing the plist is what stops the next login load.
    // A bootout that fails for a reason other than "not loaded" leaves the
    // job running until logout; the failure is in the boot-service log.
    deactivate: [
      {
        step: "stopping the service",
        command: "launchctl",
        args: ["bootout", "--wait", serviceTarget],
        optional: true,
        timeout: STOP_STEP_TIMEOUT,
      },
    ],
    finalize: [],
  };
}
