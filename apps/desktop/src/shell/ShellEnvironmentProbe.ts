import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  PROCESS_TERMINATE_GRACE,
  executableName,
  type EnvironmentPatch,
  capturePosixEnvironmentCommand,
  LOGIN_SHELL_TIMEOUT,
  extractEnvironment,
  LAUNCHCTL_TIMEOUT,
  trimNonEmpty,
  type WindowsProbeOptions,
  captureWindowsEnvironmentCommand,
  WINDOWS_SHELL_CANDIDATES,
} from "./ShellEnvironmentPolicy.ts";

export const DesktopShellEnvironmentProbe = Schema.Literals([
  "login-shell",
  "launchctl-path",
  "powershell-profile",
  "powershell-no-profile",
]);

export type DesktopShellEnvironmentProbe = typeof DesktopShellEnvironmentProbe.Type;

export const desktopShellEnvironmentCommandFields = {
  probe: DesktopShellEnvironmentProbe,
  executable: Schema.String,
  argumentCount: Schema.Number,
};

export class DesktopShellEnvironmentCommandError extends Schema.TaggedErrorClass<DesktopShellEnvironmentCommandError>()(
  "DesktopShellEnvironmentCommandError",
  {
    ...desktopShellEnvironmentCommandFields,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop shell environment ${this.probe} probe (${this.executable}) failed.`;
  }
}

export class DesktopShellEnvironmentCommandTimeoutError extends Schema.TaggedErrorClass<DesktopShellEnvironmentCommandTimeoutError>()(
  "DesktopShellEnvironmentCommandTimeoutError",
  {
    ...desktopShellEnvironmentCommandFields,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop shell environment ${this.probe} probe (${this.executable}) timed out after ${this.timeoutMs}ms.`;
  }
}

export const logShellEnvironmentCommandError = (
  error: DesktopShellEnvironmentCommandError | DesktopShellEnvironmentCommandTimeoutError,
) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      component: "desktop-shell-environment",
      error,
    }),
  );

export const runCommandOutput = Effect.fn("desktop.shellEnvironment.runCommandOutput")(
  function* (input: {
    readonly probe: DesktopShellEnvironmentProbe;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly timeout: Duration.Duration;
    readonly shell?: boolean;
  }): Effect.fn.Return<string, never, ChildProcessSpawner.ChildProcessSpawner> {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const output = yield* spawner
      .string(
        ChildProcess.make(input.command, input.args, {
          shell: input.shell ?? false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new DesktopShellEnvironmentCommandError({
              probe: input.probe,
              executable: executableName(input.command),
              argumentCount: input.args.length,
              cause,
            }),
        ),
        Effect.catchTags({
          DesktopShellEnvironmentCommandError: (error) =>
            logShellEnvironmentCommandError(error).pipe(Effect.as("")),
        }),
        Effect.timeoutOption(input.timeout),
      );

    if (Option.isSome(output)) {
      return output.value;
    }

    const error = new DesktopShellEnvironmentCommandTimeoutError({
      probe: input.probe,
      executable: executableName(input.command),
      argumentCount: input.args.length,
      timeoutMs: Duration.toMillis(input.timeout),
    });

    yield* logShellEnvironmentCommandError(error);

    return "";
  },
);

export const readLoginShellEnvironment = (
  shell: string,
  names: ReadonlyArray<string>,
): Effect.Effect<EnvironmentPatch, never, ChildProcessSpawner.ChildProcessSpawner> =>
  names.length === 0
    ? Effect.succeed({})
    : runCommandOutput({
        probe: "login-shell",
        command: shell,
        args: ["-ilc", capturePosixEnvironmentCommand(names)],
        timeout: LOGIN_SHELL_TIMEOUT,
      }).pipe(Effect.map((output) => extractEnvironment(output, names)));

export const readLaunchctlPath = runCommandOutput({
  probe: "launchctl-path",
  command: "/bin/launchctl",
  args: ["getenv", "PATH"],
  timeout: LAUNCHCTL_TIMEOUT,
}).pipe(Effect.map(trimNonEmpty));

export const readWindowsEnvironment = Effect.fn("desktop.shellEnvironment.readWindowsEnvironment")(
  function* (
    names: ReadonlyArray<string>,
    options: WindowsProbeOptions,
  ): Effect.fn.Return<EnvironmentPatch, never, ChildProcessSpawner.ChildProcessSpawner> {
    if (names.length === 0) return {};

    const args = [
      "-NoLogo",
      ...(options.loadProfile ? ([] as const) : (["-NoProfile"] as const)),
      "-NonInteractive",
      "-Command",
      captureWindowsEnvironmentCommand(names),
    ];

    for (const command of WINDOWS_SHELL_CANDIDATES) {
      const output = yield* runCommandOutput({
        probe: options.loadProfile ? "powershell-profile" : "powershell-no-profile",
        command,
        args,
        timeout: LOGIN_SHELL_TIMEOUT,
      });

      const environment = extractEnvironment(output, names);

      if (Object.keys(environment).length > 0) {
        return environment;
      }
    }

    return {};
  },
);
