import * as Duration from "effect/Duration";

import * as Effect from "effect/Effect";

import * as Option from "effect/Option";

import * as Stream from "effect/Stream";

import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildRemoteNodeEnvScript } from "@akeru/ssh/tunnel";

export const PROCESS_TERMINATE_GRACE = Duration.seconds(1);

export interface EnsureWslNodePtyOptions {
  readonly allowBuild?: boolean;
  readonly nodeEngineRange?: string | null;
}

export const buildDistroArgs = (distro: string | null): ReadonlyArray<string> =>
  distro ? ["-d", distro] : [];

export const concatChunks = (arrays: ReadonlyArray<Uint8Array>): Uint8Array => {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.byteLength;
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.byteLength;
  }
  return out;
};

export const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);

interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly transportFailure: "timeout" | "spawn" | "process" | null;
}

const TIMEOUT_RESULT: ShellResult = {
  exitCode: 124,
  stdout: "",
  stderr: "\n[timeout]",
  transportFailure: "timeout",
};

export const formatWslShellTransportFailureReason = (
  failure: ShellResult["transportFailure"],
): string | null => {
  switch (failure) {
    case "timeout":
      return "WSL backend preflight timed out while probing for Node.js. WSL may be slow to start; retry, or check that the distro is healthy.";
    case "spawn":
      return "WSL backend preflight could not start wsl.exe to probe for Node.js. Check that WSL is installed and the distro is accessible.";
    case "process":
      return "WSL backend preflight lost communication with wsl.exe while probing for Node.js. Retry, or check that the distro is healthy.";
    case null:
      return null;
  }
};

// Reuse the SSH remote resolver so WSL and SSH discover version-managed Node
// the same way. Passing the engine range lets the resolver fall through to
// version managers like nvm when a system node exists but is too old.
export const buildWslNodeEnvPreamble = (
  nodeEngineRange?: string | null,
): string => `${buildRemoteNodeEnvScript({ nodeEngineRange: nodeEngineRange ?? null })}
ensure_remote_node_path || true
`;

// wsl.exe re-escapes args before forwarding them to the Linux side, which
// mangles quotes inside `bash -lc "<script>"`. Pipe the script via stdin to
// avoid passing it on the command line at all.
export const runWslShell = (
  distro: string | null,
  bashScript: string,
  timeout: Duration.Duration,
  options: EnsureWslNodePtyOptions = {},
): Effect.Effect<ShellResult, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const spawner = ChildProcessSpawner.ChildProcessSpawner;
  // -l picks up profile-managed PATH; the shared resolver covers supported
  // version managers that non-interactive login shells can miss. -s so bash
  // reads the script from stdin.
  const command = ChildProcess.make(
    "wsl.exe",
    [...buildDistroArgs(distro), "--", "bash", "-l", "-s"],
    {
      stdin: Stream.encodeText(
        Stream.make(`${buildWslNodeEnvPreamble(options.nodeEngineRange)}${bashScript}`),
      ),
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: PROCESS_TERMINATE_GRACE,
    },
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const spawnerService = yield* spawner;
      const spawnResult = yield* spawnerService.spawn(command).pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: "Failure", error }) as const,
          onSuccess: (handle) => ({ _tag: "Success", handle }) as const,
        }),
      );
      if (spawnResult._tag === "Failure") {
        return {
          exitCode: 127,
          stdout: "",
          stderr: `\n${spawnResult.error.message}`,
          transportFailure: "spawn",
        } satisfies ShellResult;
      }
      const handle = spawnResult.handle;
      // Drain stdout and stderr concurrently so neither pipe buffer can fill
      // and stall the child (node-gyp rebuild emits large output on both).
      const [stdoutBytes, stderrBytes, exitCode] = yield* Effect.all(
        [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return {
        exitCode: exitCode,
        stdout: decodeUtf8(concatChunks(stdoutBytes)),
        stderr: decodeUtf8(concatChunks(stderrBytes)),
        transportFailure: null,
      } satisfies ShellResult;
    }),
  ).pipe(
    Effect.timeoutOption(timeout),
    Effect.map(Option.getOrElse((): ShellResult => TIMEOUT_RESULT)),
    Effect.catch((error) =>
      Effect.succeed<ShellResult>({
        exitCode: 127,
        stdout: "",
        stderr: `\n${error.message}`,
        transportFailure: "process",
      }),
    ),
  );
};

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
