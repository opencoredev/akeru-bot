import { fromJsonStringPretty } from "@akeru/shared/schemaJson";
import * as Predicate from "effect/Predicate";
import {
  HostProcessExecutablePath,
  HostProcessPlatform,
  HostProcessUserId,
} from "@akeru/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
} from "./pinnedRuntime.ts";
import {
  SERVICE_LAUNCHER_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  parseServiceState,
  serviceStateHasPendingUpdate,
  type ServiceState,
} from "./serviceProtocol.ts";
import {
  LEGACY_BOOT_SERVICE_UNIT_FILE,
  LEGACY_BOOT_SERVICE_LAUNCHD_LABEL,
  type BootServicePlan,
  type BootServiceStep,
  type BootServiceManager,
} from "./bootServiceTypes.ts";
import { isOwnedLegacyBootServiceUnit, systemdManager } from "./bootServiceSystemd.ts";
import { launchdManager } from "./bootServiceLaunchd.ts";

const encodeServiceState = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

/** Undefined means this host cannot run the background service. */
export function selectBootServiceManager(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly uid: number | undefined;
  readonly path: Path.Path;
  readonly environmentPath: string;
  /** Select the pre-rename unit so install can retire it. */
  readonly legacy?: boolean;
}): BootServiceManager | undefined {
  if (input.homeDir === "") {
    return undefined;
  }

  if (input.platform === "linux") {
    return systemdManager({
      path: input.path,
      homeDir: input.homeDir,
      ...(input.legacy ? { unitFile: LEGACY_BOOT_SERVICE_UNIT_FILE } : {}),
    });
  }

  if (input.platform === "darwin" && input.uid !== undefined) {
    return launchdManager({
      path: input.path,
      homeDir: input.homeDir,
      uid: input.uid,
      environmentPath: input.environmentPath,
      ...(input.legacy ? { label: LEGACY_BOOT_SERVICE_LAUNCHD_LABEL } : {}),
    });
  }

  return undefined;
}

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup supports Linux with systemd and macOS with launchd; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedErrorClass<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Background setup failed while ${this.step}.`
      : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class BootServiceInstallError extends Schema.TaggedErrorClass<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the Akeru Bot background service.";
  }
}

export class BootServiceUpdatePendingError extends Schema.TaggedErrorClass<BootServiceUpdatePendingError>()(
  "BootServiceUpdatePendingError",
  {},
) {
  override get message(): string {
    return "A remote server update is still pending. Wait for it to finish, then retry.";
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceInstallError
  | BootServiceUpdatePendingError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly current: boolean;
  readonly unitPath: string;
  readonly logPath: string;
}

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: Effect.Effect<BootServicePlan, BootServiceError>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("akeru-bot/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
  readonly launcherSourcePath?: string;
}

export const make = Effect.fn("cloud.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) {
  const hostExecPath = yield* HostProcessExecutablePath;
  const platform = yield* HostProcessPlatform;
  const uid = yield* HostProcessUserId;
  const homeDir = yield* Config.string("HOME").pipe(Config.withDefault(""));
  const installerPath = yield* Config.string("PATH").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const host = input.host ?? { execPath: hostExecPath };

  const xmlSafeInstallerDirectories = installerPath.split(":").filter(
    (directory) =>
      directory.length > 0 &&
      Array.from(directory).every((character) => {
        const code = character.charCodeAt(0);

        return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
      }),
  );

  const environmentPath = Array.from(
    new Set([
      ...xmlSafeInstallerDirectories,
      path.dirname(host.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ).join(":");

  const detectedManager = selectBootServiceManager({
    platform,
    homeDir,
    uid,
    path,
    environmentPath,
  });

  const legacyManager = selectBootServiceManager({
    platform,
    homeDir,
    uid,
    path,
    environmentPath,
    legacy: true,
  });

  const unitPath = detectedManager?.unitPath ?? "";
  const logPath = path.join(input.logsDir, "boot-service.log");
  const launcherPath = path.join(input.baseDir, "runtime", SERVICE_LAUNCHER_FILE);
  const statePath = path.join(input.baseDir, "runtime", SERVICE_STATE_FILE);
  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion);

  const launcherSourcePath =
    host.launcherSourcePath ??
    path.join(path.dirname(runtimePaths.entryPath), SERVICE_LAUNCHER_FILE);

  const writeDurably = (filePath: string, contents: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, { recursive: true });
        const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".service-write-" });
        yield* fs.writeFileString(tempPath, contents, { mode: 0o600 });
        yield* (yield* fs.open(tempPath, { flag: "r" })).sync;
        yield* fs.rename(tempPath, filePath);
        yield* (yield* fs.open(directory, { flag: "r" })).sync;
      }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

  const plan: BootServicePlan = {
    nodePath: host.execPath,
    launcherPath,
    baseDir: input.baseDir,
    logPath,
    unitPath,
  };

  const requireManager = Effect.suspend(() =>
    detectedManager === undefined
      ? new BootServiceUnsupportedError({ platform })
      : Effect.succeed(detectedManager),
  );

  const runStep = Effect.fn("cloud.boot_service.run_step")(function* (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeout?: Duration.Input },
  ) {
    return yield* runner.run({ command, args, timeout: options?.timeout }).pipe(
      Effect.mapError((cause) => new BootServiceCommandError({ step, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new BootServiceCommandError({
            step,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
      Effect.tapError((error) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, {
              flag: "a",
            }),
          ),
          Effect.ignore,
        ),
      ),
    );
  });

  const runSteps = (steps: ReadonlyArray<BootServiceStep>) =>
    Effect.forEach(
      steps,
      (entry) => {
        const run = runStep(
          entry.step,
          entry.command,
          entry.args,
          entry.timeout === undefined ? undefined : { timeout: entry.timeout },
        );

        // runStep's tapError already appends the failure to the log, so an
        // ignored optional step still leaves a trace.
        return entry.optional === true ? run.pipe(Effect.ignore) : run.pipe(Effect.asVoid);
      },
      { discard: true },
    );

  // A pre-rename unit that runs this base dir's launcher. Read failures and
  // units that belong to someone else (a real T3 Code install) count as none.
  const ownedLegacyManager = Effect.gen(function* () {
    if (legacyManager === undefined) return undefined;
    const contents = yield* fs.readFileString(legacyManager.unitPath).pipe(Effect.option);

    return Option.isSome(contents) && isOwnedLegacyBootServiceUnit(contents.value, launcherPath)
      ? legacyManager
      : undefined;
  });

  // Best effort: the new unit is already running, so a leftover legacy step
  // only leaves a trace in the boot-service log.
  const retireLegacy = (legacy: BootServiceManager) =>
    Effect.gen(function* () {
      yield* runSteps(legacy.deactivate).pipe(Effect.ignore);
      yield* fs.remove(legacy.unitPath).pipe(Effect.ignore);
      yield* runSteps(legacy.finalize).pipe(Effect.ignore);
    });

  const install: BootService["Service"]["install"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    yield* fs
      .makeDirectory(input.logsDir, { recursive: true })
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    // Prepare every immutable artifact before stopping the installed unit.
    yield* ensurePinnedRuntimeInstalled({
      baseDir: input.baseDir,
      version: input.cliVersion,
      fs,
      path,
      runner,
      validate: (runtime) =>
        runner
          .run({
            command: host.execPath,
            args: [runtime.entryPath, "--version"],
            timeout: Duration.seconds(30),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new PinnedRuntimeInstallError({
                  step: "verifying the pinned t3 runtime",
                  cause,
                }),
            ),
            Effect.flatMap((result) => {
              const reportedVersion = /\bv(\S+)\s*$/.exec(result.stdout)?.[1];

              return result.code === 0 && reportedVersion === input.cliVersion
                ? Effect.void
                : Effect.fail(
                    new PinnedRuntimeInstallError({
                      step: "verifying the pinned t3 runtime",
                      exitCode: Number(result.code),
                      stdoutLength: result.stdout.length,
                      stderrLength: result.stderr.length,
                    }),
                  );
            }),
          ),
    }).pipe(
      Effect.mapError((error) =>
        Predicate.isTagged(error, "PinnedRuntimeInstallError")
          ? new BootServiceCommandError({
              step: error.step,
              exitCode: error.exitCode,
              stdoutLength: error.stdoutLength,
              stderrLength: error.stderrLength,
              cause: error,
            })
          : new BootServiceInstallError({ cause: error }),
      ),
    );

    const launcherSource = yield* fs
      .readFileString(launcherSourcePath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    const installed = yield* fs
      .exists(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    const legacy = yield* ownedLegacyManager;

    if (installed) {
      yield* runSteps(manager.stop);
    }

    // Both units would serve the same base dir and port, so the legacy one
    // stops before the renamed unit starts.
    if (legacy !== undefined) {
      yield* runSteps(legacy.stop);
    }

    yield* Effect.gen(function* () {
      if (installed || legacy !== undefined) {
        const previousStateText = yield* fs.readFileString(statePath).pipe(Effect.option);

        if (
          Option.isSome(previousStateText) &&
          serviceStateHasPendingUpdate(previousStateText.value)
        ) {
          return yield* new BootServiceUpdatePendingError();
        }
      }

      yield* fs
        .makeDirectory(path.dirname(unitPath), { recursive: true })
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      yield* writeDurably(launcherPath, launcherSource);
      yield* writeDurably(
        statePath,
        `${yield* encodeServiceState({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: input.cliVersion,
        } satisfies ServiceState).pipe(Effect.orDie)}\n`,
      );
      yield* writeDurably(unitPath, manager.render(plan));

      yield* runSteps(manager.activate);
    }).pipe(
      Effect.tapError(() =>
        installed
          ? runSteps(manager.restart).pipe(Effect.ignore)
          : legacy !== undefined
            ? runSteps(legacy.restart).pipe(Effect.ignore)
            : Effect.void,
      ),
    );

    if (legacy !== undefined) {
      yield* retireLegacy(legacy);
    }

    return plan;
  }).pipe(Effect.withSpan("cloud.boot_service.install"));

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    const manager = yield* requireManager;
    const legacy = yield* ownedLegacyManager;

    if (legacy !== undefined) {
      yield* retireLegacy(legacy);
    }

    if (
      !(yield* fs
        .exists(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause }))))
    )
      return legacy !== undefined;
    yield* runSteps(manager.deactivate);
    yield* fs
      .remove(unitPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    yield* runSteps(manager.finalize);

    return true;
  }).pipe(Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (detectedManager === undefined) {
      return { supported: false, installed: false, current: false, unitPath, logPath };
    }

    if (!(yield* fs.exists(unitPath))) {
      // An upgraded install still running under the legacy name needs a repair,
      // which renames it.
      const legacy = yield* ownedLegacyManager;

      return legacy === undefined
        ? { supported: true, installed: false, current: false, unitPath, logPath }
        : { supported: true, installed: true, current: false, unitPath: legacy.unitPath, logPath };
    }

    const [unit, launcherExists, runtimeEntryExists, runtimeSentinel, stateText] =
      yield* Effect.all([
        fs.readFileString(unitPath),
        fs.exists(launcherPath),
        fs.exists(runtimePaths.entryPath),
        fs.readFileString(runtimePaths.sentinelPath).pipe(Effect.option),
        fs.readFileString(statePath).pipe(Effect.option),
      ]);

    const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;

    const normalizeUnit = (contents: string) =>
      detectedManager.kind === "launchd"
        ? contents.replace(/(<key>PATH<\/key>\n\s*<string>)[^<]*(<\/string>)/, "$1$2")
        : contents;

    return {
      supported: true,
      installed: true,
      current:
        normalizeUnit(unit) === normalizeUnit(detectedManager.render(plan)) &&
        launcherExists &&
        runtimeEntryExists &&
        Option.isSome(runtimeSentinel) &&
        runtimeSentinel.value.trim() === input.cliVersion &&
        state?.activeVersion === input.cliVersion &&
        state?.update?.status !== "pending",
      unitPath,
      logPath,
    };
  }).pipe(
    Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    Effect.withSpan("cloud.boot_service.status"),
  );

  return BootService.of({ install, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
}) => Layer.effect(BootService, make(input));

export { BOOT_SERVICE_UNIT_FILE } from "./bootServiceTypes.ts";

export { BOOT_SERVICE_LAUNCHD_LABEL } from "./bootServiceTypes.ts";

export { BOOT_SERVICE_PLIST_FILE } from "./bootServiceTypes.ts";

export { BOOT_SERVICE_UNIT_ENV } from "./bootServiceTypes.ts";

export { LEGACY_BOOT_SERVICE_UNIT_FILE } from "./bootServiceTypes.ts";

export { LEGACY_BOOT_SERVICE_LAUNCHD_LABEL } from "./bootServiceTypes.ts";

export { escapeSystemdSpecifiers } from "./bootServiceSystemd.ts";

export { quoteSystemdValue } from "./bootServiceSystemd.ts";

export type { BootServicePlan } from "./bootServiceTypes.ts";

export { isOwnedLegacyBootServiceUnit } from "./bootServiceSystemd.ts";

export { renderBootServiceUnit } from "./bootServiceSystemd.ts";

export { escapeXmlText } from "./bootServiceLaunchd.ts";

export { renderBootServicePlist } from "./bootServiceLaunchd.ts";

export type { BootServiceStep } from "./bootServiceTypes.ts";

export type { BootServiceManager } from "./bootServiceTypes.ts";

export { systemdManager } from "./bootServiceSystemd.ts";

export { launchdManager } from "./bootServiceLaunchd.ts";
