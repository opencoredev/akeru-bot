import type { DesktopSshEnvironmentTarget } from "@akeru/contracts";
import { extractJsonObject, fromLenientJson } from "@akeru/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { type SshAuthOptions } from "./auth.ts";
import { getLastNonEmptyOutputLine, remoteStateKey, runSshCommand } from "./command.ts";
import {
  SshCommandError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
} from "./errors.ts";
import {
  REMOTE_LAUNCH_TIMEOUT_MS,
  type RemoteT3RunnerOptions,
  sshTargetLogFields,
  sshRunnerLogFields,
} from "./types.ts";
import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
  buildRemoteLogTailScript,
} from "./remoteScripts.ts";

const RemoteLaunchResult = Schema.Struct({
  remotePort: Schema.Number,
  serverKind: Schema.optional(Schema.Literals(["external", "managed"])),
});

const RemotePairingResult = Schema.Struct({
  credential: Schema.String,
});

const decodeRemoteLaunchResult = Schema.decodeEffect(fromLenientJson(RemoteLaunchResult));

const decodeRemotePairingResult = Schema.decodeEffect(fromLenientJson(RemotePairingResult));

const decodeRemoteJsonOutput = <A, E>(
  stdout: string,
  decode: (input: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  decode(stdout).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const jsonObject = extractJsonObject(stdout);
        if (jsonObject === stdout.trim()) {
          return yield* Effect.fail(error);
        }
        const exit = yield* Effect.exit(decode(jsonObject));
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        return yield* Effect.fail(error);
      }),
    ),
  );

const decodeRemoteLaunchOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemoteLaunchResult);

const decodeRemotePairingOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemotePairingResult);

export const launchOrReuseRemoteServer = Effect.fn("ssh/tunnel.launchOrReuseRemoteServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: SshAuthOptions,
    runner?: RemoteT3RunnerOptions,
  ): Effect.fn.Return<
    { readonly remotePort: number; readonly remoteServerKind: "external" | "managed" | null },
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    yield* Effect.logInfo("ssh.remoteServer.launch.start", {
      ...sshTargetLogFields(target),
      ...sshRunnerLogFields(runner),
      stateKey: remoteStateKey(target),
    });
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-l", "-s", "--", remoteStateKey(target)],
      stdin: buildRemoteLaunchScript(runner),
      timeoutMs: REMOTE_LAUNCH_TIMEOUT_MS,
      ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    });
    if (!getLastNonEmptyOutputLine(result.stdout)) {
      return yield* new SshLaunchError({
        message: "SSH launch did not return a remote port.",
        stdout: result.stdout,
      });
    }
    const parsed = yield* decodeRemoteLaunchOutput(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({
            message: "SSH launch returned unparseable output.",
            stdout: result.stdout,
            cause,
          }),
      ),
    );
    if (!Number.isInteger(parsed.remotePort)) {
      return yield* new SshLaunchError({
        message: `SSH launch returned an invalid remote port: ${String(parsed.remotePort)}.`,
        stdout: result.stdout,
      });
    }
    yield* Effect.logInfo("ssh.remoteServer.launch.ready", {
      ...sshTargetLogFields(target),
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
      stateKey: remoteStateKey(target),
    });
    return {
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
    };
  },
);

export const issueRemotePairingToken = Effect.fn("ssh/tunnel.issueRemotePairingToken")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
  runner?: RemoteT3RunnerOptions,
): Effect.fn.Return<
  {
    readonly credential: string;
  },
  SshCommandError | SshInvalidTargetError | SshPairingError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.start", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemotePairingScript(target, runner),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  if (!getLastNonEmptyOutputLine(result.stdout)) {
    return yield* new SshPairingError({
      message: "SSH pairing did not return a credential.",
      stdout: result.stdout,
    });
  }
  const parsed = yield* decodeRemotePairingOutput(result.stdout).pipe(
    Effect.mapError(
      (cause) =>
        new SshPairingError({
          message: "SSH pairing returned unparseable output.",
          stdout: result.stdout,
          cause,
        }),
    ),
  );
  if (parsed.credential.trim().length === 0) {
    return yield* new SshPairingError({
      message: "SSH pairing command returned an invalid credential.",
      stdout: result.stdout,
    });
  }
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.created", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  return {
    credential: parsed.credential,
  };
});

export const stopRemoteServer = Effect.fn("ssh/tunnel.stopRemoteServer")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
): Effect.fn.Return<
  void,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  yield* Effect.logInfo("ssh.remoteServer.stop.start", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteStopScript(target),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  yield* Effect.logInfo("ssh.remoteServer.stop.succeeded", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
});

export const readRemoteServerLogTail = Effect.fn("ssh/tunnel.readRemoteServerLogTail")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
): Effect.fn.Return<
  string,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteLogTailScript(target),
    timeoutMs: 10_000,
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  return result.stdout.trim();
});
