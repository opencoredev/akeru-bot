import * as Cause from "effect/Cause";

import * as Duration from "effect/Duration";

import * as Effect from "effect/Effect";

import * as Exit from "effect/Exit";

import * as Fiber from "effect/Fiber";

import * as Option from "effect/Option";

import * as PlatformError from "effect/PlatformError";

import * as Schema from "effect/Schema";

import * as Scope from "effect/Scope";

import * as Stream from "effect/Stream";

import { HttpClient } from "effect/unstable/http";

import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
  DesktopTelemetryControlMessage,
  type DesktopTelemetryControlMessage as DesktopTelemetryControlMessageValue,
} from "@akeru/contracts";

import { waitForHttpReady as waitForHttpReadyShared } from "@akeru/shared/httpReadiness";

import * as DesktopObservability from "../app/DesktopObservability.ts";

const DEFAULT_BACKEND_READINESS_TIMEOUT = Duration.minutes(1);

const DEFAULT_BACKEND_READINESS_INTERVAL = Duration.millis(100);

const DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT = Duration.seconds(1);

const DEFAULT_BACKEND_TERMINATE_GRACE = Duration.seconds(2);

const DEFAULT_BACKEND_OUTPUT_DRAIN_TIMEOUT = Duration.seconds(5);

const BACKEND_READINESS_PATH = "/.well-known/t3/environment";

const { logWarning: logBackendProcessWarning } =
  DesktopObservability.makeComponentLogger("desktop-backend-process");

type BackendProcessLayerServices = ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient;

type BackendProcessRunRequirements = BackendProcessLayerServices | Scope.Scope;

export type BackendProcessOutputStream = "stdout" | "stderr";

export interface BackendProcessContext {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
  readonly httpBaseUrl: URL;
}

export type DesktopBackendBootstrapDelivery = "fd3" | "stdin";

export interface DesktopBackendStartConfig extends BackendProcessContext {
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
  // When true the spawner merges the desktop process.env on top of `env`;
  // when false `env` is passed verbatim. WSL mode opts out so a leaking
  // T3CODE_HOME can't pin the WSL backend to /mnt/c/...\.t3.
  readonly extendEnv: boolean;
  readonly bootstrap: DesktopBackendBootstrapValue;
  readonly bootstrapDelivery: DesktopBackendBootstrapDelivery;
  readonly httpBaseUrl: URL;
  readonly captureOutput: boolean;
  readonly preflightFailure: Option.Option<PreflightFailure>;
  // Present for a WSL run after the configured/default distro has been
  // resolved to the concrete distro passed to wsl.exe.
  readonly runningDistro?: string;
}

// A preflight failure records whether it is fatal. Transient failures (WSL
// cold-starting, wslpath while the VM boots) keep retrying so the backend can
// self-heal; fatal ones (no node, wrong version, missing build tools) are
// surfaced via onPreflightFailed and stop the restart loop after
// MAX_PREFLIGHT_FAILURE_ATTEMPTS.
export interface PreflightFailure {
  readonly reason: string;
  readonly fatal: boolean;
  readonly retryLimit?: number;
}

interface BackendProcessExit {
  readonly code: Option.Option<number>;
  readonly reason: string;
}

const backendProcessContextSchema = {
  executablePath: Schema.String,
  entryPath: Schema.String,
  cwd: Schema.String,
  httpBaseUrl: Schema.URL,
};

export class BackendReadinessTimeoutError extends Schema.TaggedErrorClass<BackendReadinessTimeoutError>()(
  "BackendReadinessTimeoutError",
  {
    ...backendProcessContextSchema,
    readinessUrl: Schema.URL,
    timeoutMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Timed out after ${this.timeoutMs}ms waiting for desktop backend readiness at ${this.readinessUrl.href}.`;
  }
}

export class BackendProcessBootstrapEncodeError extends Schema.TaggedErrorClass<BackendProcessBootstrapEncodeError>()(
  "BackendProcessBootstrapEncodeError",
  {
    ...backendProcessContextSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode the desktop backend bootstrap payload for ${this.entryPath}.`;
  }
}

export class BackendProcessSpawnError extends Schema.TaggedErrorClass<BackendProcessSpawnError>()(
  "BackendProcessSpawnError",
  {
    ...backendProcessContextSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn desktop backend entry ${this.entryPath} with ${this.executablePath}.`;
  }
}

export class BackendProcessOutputReadError extends Schema.TaggedErrorClass<BackendProcessOutputReadError>()(
  "BackendProcessOutputReadError",
  {
    ...backendProcessContextSchema,
    pid: Schema.Number,
    streamName: Schema.Literals(["stdout", "stderr"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.streamName} from desktop backend process ${this.pid}.`;
  }
}

export class BackendProcessOutputHandlingError extends Schema.TaggedErrorClass<BackendProcessOutputHandlingError>()(
  "BackendProcessOutputHandlingError",
  {
    ...backendProcessContextSchema,
    pid: Schema.Number,
    streamName: Schema.Literals(["stdout", "stderr"]),
    chunkByteLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle ${this.chunkByteLength} bytes from ${this.streamName} of desktop backend process ${this.pid}.`;
  }
}

export type BackendProcessOutputError =
  | BackendProcessOutputReadError
  | BackendProcessOutputHandlingError;

export class BackendProcessExitStatusError extends Schema.TaggedErrorClass<BackendProcessExitStatusError>()(
  "BackendProcessExitStatusError",
  {
    ...backendProcessContextSchema,
    pid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the exit status of desktop backend process ${this.pid}.`;
  }
}

export const BackendProcessError = Schema.Union([
  BackendProcessBootstrapEncodeError,
  BackendProcessSpawnError,
  BackendProcessExitStatusError,
]);

export type BackendProcessError = typeof BackendProcessError.Type;

interface RunBackendProcessOptions extends DesktopBackendStartConfig {
  readonly desktopTelemetryStream: Stream.Stream<Uint8Array>;
  readonly onDesktopTelemetryControl?: (
    message: DesktopTelemetryControlMessageValue,
  ) => Effect.Effect<void>;
  readonly readinessTimeout?: Duration.Duration;
  readonly outputDrainTimeout?: Duration.Duration;
  readonly onStarted?: (pid: number) => Effect.Effect<void>;
  readonly onExitObserved?: () => Effect.Effect<void>;
  readonly onReady?: () => Effect.Effect<void>;
  readonly onReadinessFailure?: (error: BackendReadinessTimeoutError) => Effect.Effect<void>;
  readonly onOutput?: (
    streamName: BackendProcessOutputStream,
    chunk: Uint8Array,
  ) => Effect.Effect<void, Error>;
  readonly onOutputFailure?: (error: BackendProcessOutputError) => Effect.Effect<void>;
}

export const waitForHttpReady = (
  options: BackendProcessContext & { readonly timeout: Duration.Duration },
): Effect.Effect<void, BackendReadinessTimeoutError, HttpClient.HttpClient> => {
  const readinessUrl = new URL(BACKEND_READINESS_PATH, options.httpBaseUrl);
  return waitForHttpReadyShared({
    baseUrl: options.httpBaseUrl.href,
    path: BACKEND_READINESS_PATH,
    timeoutMs: Duration.toMillis(options.timeout),
    intervalMs: Duration.toMillis(DEFAULT_BACKEND_READINESS_INTERVAL),
    probeTimeoutMs: Duration.toMillis(DEFAULT_BACKEND_READINESS_REQUEST_TIMEOUT),
    makeError: ({ cause }) =>
      new BackendReadinessTimeoutError({
        executablePath: options.executablePath,
        entryPath: options.entryPath,
        cwd: options.cwd,
        httpBaseUrl: options.httpBaseUrl,
        readinessUrl,
        timeoutMs: Duration.toMillis(options.timeout),
        cause,
      }),
  });
};

function drainBackendOutput(
  context: BackendProcessContext & { readonly pid: number },
  streamName: BackendProcessOutputStream,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  onOutput: (
    streamName: BackendProcessOutputStream,
    chunk: Uint8Array,
  ) => Effect.Effect<void, Error>,
  onOutputFailure: (error: BackendProcessOutputError) => Effect.Effect<void>,
): Effect.Effect<void> {
  return stream.pipe(
    Stream.mapError(
      (cause) =>
        new BackendProcessOutputReadError({
          ...context,
          streamName,
          cause,
        }),
    ),
    Stream.runForEach((chunk) =>
      onOutput(streamName, chunk).pipe(
        Effect.mapError(
          (cause) =>
            new BackendProcessOutputHandlingError({
              ...context,
              streamName,
              chunkByteLength: chunk.byteLength,
              cause,
            }),
        ),
        Effect.catchTag("BackendProcessOutputHandlingError", onOutputFailure),
      ),
    ),
    Effect.catchTags({
      BackendProcessOutputReadError: onOutputFailure,
    }),
  );
}

const encodeBootstrapJson = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

const decodeDesktopTelemetryControlLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);

export const runBackendProcess = Effect.fn("runBackendProcess")(function* (
  options: RunBackendProcessOptions,
): Effect.fn.Return<BackendProcessExit, BackendProcessError, BackendProcessRunRequirements> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bootstrapJson = yield* encodeBootstrapJson(options.bootstrap).pipe(
    Effect.mapError(
      (cause) =>
        new BackendProcessBootstrapEncodeError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          httpBaseUrl: options.httpBaseUrl,
          cause,
        }),
    ),
  );
  const onOutput = options.onOutput ?? (() => Effect.void);
  const bootstrapStream = Stream.encodeText(Stream.make(`${bootstrapJson}\n`));
  const additionalFds: Record<`fd${number}`, ChildProcess.AdditionalFdConfig> = {};
  if (options.bootstrapDelivery === "fd3") {
    additionalFds.fd3 = {
      type: "input",
      stream: bootstrapStream,
    };
    if (options.bootstrap.desktopTelemetryFd !== undefined) {
      additionalFds[`fd${options.bootstrap.desktopTelemetryFd}`] = {
        type: "input",
        stream: options.desktopTelemetryStream,
      };
    }
    if (options.bootstrap.desktopTelemetryControlFd !== undefined) {
      additionalFds[`fd${options.bootstrap.desktopTelemetryControlFd}`] = {
        type: "output",
      };
    }
  }
  const command = ChildProcess.make(options.executablePath, options.args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: options.extendEnv,
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    stdin: options.bootstrapDelivery === "stdin" ? bootstrapStream : "ignore",
    stdout: options.captureOutput ? "pipe" : "inherit",
    stderr: options.captureOutput ? "pipe" : "inherit",
    killSignal: "SIGTERM",
    forceKillAfter: DEFAULT_BACKEND_TERMINATE_GRACE,
    // wsl.exe drops additional file descriptors when forwarding to the Linux
    // side, so the WSL spawn path delivers the bootstrap envelope via stdin
    // (`--bootstrap-fd 0`) instead.
    ...(options.bootstrapDelivery === "fd3" ? { additionalFds } : {}),
  });

  const handle = yield* spawner.spawn(command).pipe(
    Effect.mapError(
      (cause) =>
        new BackendProcessSpawnError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          httpBaseUrl: options.httpBaseUrl,
          cause,
        }),
    ),
  );
  const outputFibers: Array<Fiber.Fiber<void, never>> = [];

  yield* options.onStarted?.(handle.pid) ?? Effect.void;
  if (
    options.bootstrap.desktopTelemetryControlFd !== undefined &&
    options.onDesktopTelemetryControl !== undefined
  ) {
    const controlFd = options.bootstrap.desktopTelemetryControlFd;
    const handleControl = options.onDesktopTelemetryControl;
    yield* handle.getOutputFd(controlFd).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.runForEach((line) =>
        decodeDesktopTelemetryControlLine(line).pipe(
          Effect.flatMap(handleControl),
          Effect.catchCause((cause) =>
            logBackendProcessWarning("ignored invalid desktop telemetry control message", {
              fd: controlFd,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        logBackendProcessWarning("desktop telemetry control stream stopped", {
          fd: controlFd,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.ensuring(
        handleControl({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: false,
        }),
      ),
      Effect.forkScoped,
    );
  }
  if (options.captureOutput) {
    const outputContext = {
      executablePath: options.executablePath,
      entryPath: options.entryPath,
      cwd: options.cwd,
      httpBaseUrl: options.httpBaseUrl,
      pid: Number(handle.pid),
    };
    const onOutputFailure = options.onOutputFailure ?? (() => Effect.void);
    outputFibers.push(
      yield* drainBackendOutput(
        outputContext,
        "stdout",
        handle.stdout,
        onOutput,
        onOutputFailure,
      ).pipe(Effect.forkScoped),
      yield* drainBackendOutput(
        outputContext,
        "stderr",
        handle.stderr,
        onOutput,
        onOutputFailure,
      ).pipe(Effect.forkScoped),
    );
  }
  // Probe readiness in a loop while the backend process is still alive
  // instead of giving up after the first budget. A slow cold boot (the
  // WSL bundle loading across /mnt/c, or a first launch right after an
  // update) can exceed the initial readiness budget while the backend is
  // about to come up moments later; a one-shot probe left the app stuck
  // on "Connecting to WSL…" forever even though the backend kept running
  // and became healthy. Each round gets a fresh budget, and the forked
  // loop is torn down with the run scope once the child exits.
  const probeReadiness = Effect.fn("desktop.backendProcess.probeReadiness")(() =>
    waitForHttpReady({
      executablePath: options.executablePath,
      entryPath: options.entryPath,
      cwd: options.cwd,
      httpBaseUrl: options.httpBaseUrl,
      timeout: options.readinessTimeout ?? DEFAULT_BACKEND_READINESS_TIMEOUT,
    }).pipe(
      Effect.flatMap(() => options.onReady?.() ?? Effect.void),
      Effect.as(true),
      Effect.catchTags({
        BackendReadinessTimeoutError: (error) =>
          (options.onReadinessFailure?.(error) ?? Effect.void).pipe(Effect.as(false)),
      }),
    ),
  );

  yield* probeReadiness().pipe(Effect.repeat({ while: (ready) => !ready }), Effect.forkScoped);

  const exit = yield* handle.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new BackendProcessExitStatusError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          httpBaseUrl: options.httpBaseUrl,
          pid: Number(handle.pid),
          cause,
        }),
    ),
    Effect.exit,
  );
  yield* options.onExitObserved?.() ?? Effect.void;
  yield* Effect.forEach(outputFibers, Fiber.await, {
    concurrency: "unbounded",
    discard: true,
  }).pipe(
    Effect.timeout(options.outputDrainTimeout ?? DEFAULT_BACKEND_OUTPUT_DRAIN_TIMEOUT),
    Effect.ignore,
  );
  if (Exit.isFailure(exit)) {
    return yield* Effect.failCause(exit.cause);
  }
  const exitCode = exit.value;
  return {
    code: Option.some(exitCode),
    reason: `code=${exitCode}`,
  } satisfies BackendProcessExit;
});
