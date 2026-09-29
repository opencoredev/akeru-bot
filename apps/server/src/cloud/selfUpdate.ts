import {
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import {
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  PinnedRuntimeInstallError,
  PinnedRuntimePreflightBlockedError,
} from "./pinnedRuntime.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { isExactServiceVersion, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const PREFLIGHT_TIMEOUT = Duration.seconds(30);

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  if (input.desktopManaged) return "desktop-managed" as const;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput & { readonly source?: "remote-archive" },
      reportProgress?: (stage: ServerSelfUpdateProgressStage) => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
  }
>()("akeru-bot/cloud/selfUpdate/ServerSelfUpdate") {}

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const execPath = yield* HostProcessExecutablePath;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const artifactRoot =
    environment.AKERU_SERVICE_RUNTIME_ROOT ??
    path.resolve(path.dirname(execPath), platform === "win32" ? ".." : "../..");
  const inFlight = yield* Ref.make(false);

  const capability: ServerSelfUpdateCapability | null =
    serverConfig.mode === "desktop" ? "desktop-managed" : launcher.managed ? "boot-service" : null;
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (input, reportProgress = () => Effect.void) {
    if (capability === "desktop-managed") {
      return yield* failWith(
        "This server is managed by the Akeru Bot desktop app on its machine; update the desktop app to update it.",
      );
    }
    if (capability === null) {
      return yield* failWith(
        "Remote updates require the Akeru Bot background service. Run `akeru service install` on the server machine.",
      );
    }

    const targetVersion = input.targetVersion.trim();
    if (!isExactServiceVersion(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact akeru-bot version.`);
    }
    if (yield* Ref.getAndSet(inFlight, true)) {
      return yield* failWith("A server update is already in progress.");
    }

    return yield* Effect.gen(function* () {
      yield* reportProgress("downloading");
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir: serverConfig.baseDir,
        version: targetVersion,
        fs,
        path,
        runner,
        ...(input.source === "remote-archive"
          ? {
              prepareArchive: (runtime) =>
                Effect.scoped(
                  Effect.gen(function* () {
                    const installRoot = yield* fs.makeTempDirectoryScoped({
                      directory: path.dirname(runtime.versionDir),
                      prefix: ".archive-",
                    });
                    const windows = platform === "win32";
                    const installer = path.join(
                      artifactRoot,
                      windows ? "install-remote.ps1" : "install-remote.sh",
                    );
                    const result = yield* runner.run({
                      command: windows ? "powershell.exe" : "sh",
                      args: windows
                        ? [
                            "-NoProfile",
                            "-ExecutionPolicy",
                            "Bypass",
                            "-File",
                            installer,
                            "-PrepareOnly",
                            "-Tag",
                            `v${targetVersion}`,
                          ]
                        : [installer, "--prepare-only", "--tag", `v${targetVersion}`],
                      env: {
                        ...environment,
                        AKERU_HOME: serverConfig.baseDir,
                        T3CODE_HOME: serverConfig.baseDir,
                        AKERU_INSTALL_ROOT: installRoot,
                        AKERU_BIN_DIR: path.join(installRoot, "bin"),
                      },
                      timeout: Duration.minutes(10),
                    });
                    if (result.code !== 0)
                      return yield* new PinnedRuntimeInstallError({
                        step: "verifying the remote release archive",
                        exitCode: Number(result.code),
                        stdoutLength: result.stdout.length,
                        stderrLength: result.stderr.length,
                      });
                    const archiveRoot = path.join(installRoot, "versions", targetVersion);
                    yield* fs.copy(archiveRoot, runtime.versionDir, { overwrite: true });
                  }),
                ).pipe(
                  Effect.mapError((cause) =>
                    Schema.is(PinnedRuntimeInstallError)(cause)
                      ? cause
                      : new PinnedRuntimeInstallError({
                          step: "preparing the verified remote archive",
                          cause,
                        }),
                  ),
                ),
            }
          : {}),
        validate: (runtime) =>
          runner
            .run({
              command: execPath,
              args: [
                runtime.entryPath,
                "__service-preflight",
                "--database-path",
                serverConfig.dbPath,
                "--launcher-protocol",
                String(SERVICE_LAUNCHER_PROTOCOL),
              ],
              timeout: PREFLIGHT_TIMEOUT,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new PinnedRuntimeInstallError({
                    step: "running the staged service preflight",
                    cause,
                  }),
              ),
              Effect.flatMap(
                (
                  result,
                ): Effect.Effect<
                  void,
                  PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
                > => {
                  if (result.code !== 0) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "running the staged service preflight",
                        exitCode: Number(result.code),
                        stdoutLength: result.stdout.length,
                        stderrLength: result.stderr.length,
                      }),
                    );
                  }
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(result.stdout.trim());
                  } catch (cause) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "decoding the staged service preflight",
                        cause,
                      }),
                    );
                  }
                  const preflight = decodeServicePreflightResult(parsed);
                  if (preflight === undefined || preflight.version !== targetVersion) {
                    return Effect.fail(
                      new PinnedRuntimeInstallError({
                        step: "verifying the staged service preflight",
                      }),
                    );
                  }
                  return preflight.status === "ready"
                    ? Effect.void
                    : Effect.fail(
                        new PinnedRuntimePreflightBlockedError({
                          version: targetVersion,
                          reason: preflight.reason,
                        }),
                      );
                },
              ),
            ),
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PinnedRuntimePreflightBlockedError"
            ? failWith(error.reason, error)
            : failWith(`Could not prepare akeru-bot@${targetVersion}.`, error),
        ),
      );

      yield* reportProgress("installing");
      const updateId = yield* launcher
        .requestUpdate({ targetVersion, dbPath: serverConfig.dbPath })
        .pipe(
          Effect.mapError((error) =>
            failWith(
              error._tag === "ServiceLauncherRejectedError"
                ? error.reason
                : "Could not ask the service launcher to activate the prepared update.",
              error,
            ),
          ),
        );

      yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
        updateId,
        targetVersion,
        runtimePath: paths.entryPath,
      });
      return { targetVersion, method: "boot-service" as const, updateId };
    }).pipe(Effect.onError(() => Ref.set(inFlight, false)));
  });

  return ServerSelfUpdate.of({ update });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
