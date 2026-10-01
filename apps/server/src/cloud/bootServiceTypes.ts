import * as Duration from "effect/Duration";

export const BOOT_SERVICE_NAME = "akeru-bot";

export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;

// `.service` suffix keeps the label distinct from the desktop app's bundle id
// (dev.leodoes.akeru), so launchd and TCC records never collide.
export const BOOT_SERVICE_LAUNCHD_LABEL = "dev.leodoes.akeru.service";

export const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;

export const BOOT_SERVICE_UNIT_ENV = "AKERU_BOOT_SERVICE_UNIT";

/**
 * Names Akeru installs used before the rename. T3 Code uses the same names, so
 * install only retires a legacy unit that runs this base dir's launcher; see
 * {@link isOwnedLegacyBootServiceUnit}.
 */
export const LEGACY_BOOT_SERVICE_UNIT_FILE = "t3code.service";

export const LEGACY_BOOT_SERVICE_LAUNCHD_LABEL = "com.t3tools.t3code.service";

export interface BootServicePlan {
  readonly nodePath: string;
  readonly launcherPath: string;
  readonly baseDir: string;
  readonly logPath: string;
  readonly unitPath: string;
}

export interface BootServiceStep {
  readonly step: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * Non-zero exit is logged and ignored. Reserved for steps whose common
   * failures (not loaded, already enabled) leave a state a later strict step
   * either tolerates or fails loudly on.
   */
  readonly optional?: boolean;
  /** Override the ProcessRunner default (60s) for steps that block longer. */
  readonly timeout?: Duration.Input;
}

/**
 * Stop commands block until the service manager gives up: 90s by default for
 * systemd's TimeoutStopSec, and ExitTimeOut=90 in the rendered plist. This
 * must stay above both, or the runner cancels the stop mid-shutdown and the
 * next step races a still-loaded service.
 */
export const STOP_STEP_TIMEOUT = Duration.seconds(120);

/**
 * Platform service-manager integration as data: paths, a pure renderer, and
 * the command steps each flow runs. install/uninstall/status consume this and
 * never branch on platform.
 */
export interface BootServiceManager {
  readonly kind: "systemd" | "launchd";
  readonly unitPath: string;
  readonly render: (plan: BootServicePlan) => string;
  /** Before rewriting files, when a unit is already installed. */
  readonly stop: ReadonlyArray<BootServiceStep>;
  /** After files are written. The last entry starts the service. */
  readonly activate: ReadonlyArray<BootServiceStep>;
  /** Best-effort recovery after a failed repair of an installed service. */
  readonly restart: ReadonlyArray<BootServiceStep>;
  /** Uninstall, before the unit file is removed. */
  readonly deactivate: ReadonlyArray<BootServiceStep>;
  /** Uninstall, after the unit file is removed. */
  readonly finalize: ReadonlyArray<BootServiceStep>;
}
