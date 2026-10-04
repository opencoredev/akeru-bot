import type { DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentTarget } from "@akeru/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";
import { SshPasswordPrompt, isSshAuthFailure } from "./auth.ts";
import { buildSshHostSpecEffect, resolveSshTarget, targetConnectionKey } from "./command.ts";
import { SshInvalidTargetError, SshPasswordPromptError } from "./errors.ts";
import {
  TUNNEL_SHUTDOWN_TIMEOUT_MS,
  type RemoteT3RunnerOptions,
  type SshEnvironmentManagerOptions,
  type SshTunnelEntry,
  type SshEnvironmentEffectContext,
  type SshEnvironmentEffectError,
  sshTargetLogFields,
  sshRunnerLogFields,
  type SshAuthOperationInput,
  type SshAuthAttemptInput,
  type SshEnvironmentManagerShape,
} from "./types.ts";
import {
  launchOrReuseRemoteServer,
  issueRemotePairingToken,
  stopRemoteServer,
} from "./remoteServer.ts";
import { waitForHttpReady } from "./readiness.ts";
import { reserveLocalTunnelPort, startSshTunnel } from "./tunnelTransport.ts";

// Re-exported from the shared HTTP readiness module so existing importers
// (notably tunnel.test.ts) keep resolving it from here.
export { describeReadinessCause } from "@akeru/shared/httpReadiness";

const makeSshEnvironmentManager = Effect.fn("ssh/tunnel.SshEnvironmentManager.make")(function* (
  options: SshEnvironmentManagerOptions = {},
): Effect.fn.Return<SshEnvironmentManagerShape, never, Scope.Scope> {
  const managerScope = yield* Scope.Scope;
  const tunnels = new Map<string, SshTunnelEntry>();
  const targetLocks = new Map<string, Semaphore.Semaphore>();
  const authSecrets = new Map<string, string>();

  // Keep one lock per target so reconnect cannot reuse a server while stop is pending.
  const withTargetLock = Effect.fn("ssh/tunnel.withTargetLock")(function* <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    let lock = targetLocks.get(key);

    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      targetLocks.set(key, lock);
    }

    return yield* lock.withPermits(1)(effect);
  });

  const closeTunnelEntry = Effect.fn("ssh/tunnel.closeTunnelEntry")(function* (
    entry: SshTunnelEntry,
  ) {
    yield* Effect.logDebug("ssh.tunnel.close.start", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
    yield* Effect.logInfo("ssh.tunnel.close.succeeded", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
  });

  yield* Scope.addFinalizer(
    managerScope,
    Effect.sync(() => [...tunnels.values()]).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, closeTunnelEntry, { concurrency: "unbounded" }),
      ),
      Effect.ignore,
    ),
  );

  const promptForPassword = Effect.fn("ssh/tunnel.promptForPassword")(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<string, SshInvalidTargetError | SshPasswordPromptError, SshPasswordPrompt> {
    const promptService = yield* SshPasswordPrompt;
    const hostSpec = yield* buildSshHostSpecEffect(target);

    if (!promptService.isAvailable) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.unavailable", {
        ...sshTargetLogFields(target),
        attempt,
      });

      return yield* new SshPasswordPromptError({
        message: `SSH authentication failed for ${hostSpec}.`,
      });
    }

    yield* Effect.logInfo("ssh.auth.passwordPrompt.request", {
      ...sshTargetLogFields(target),
      attempt,
    });

    const password = yield* promptService.request({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password for ${hostSpec}.`,
    });

    if (password === null) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.cancelled", {
        ...sshTargetLogFields(target),
        attempt,
      });

      return yield* new SshPasswordPromptError({
        message: `SSH authentication cancelled for ${hostSpec}.`,
      });
    }

    yield* Effect.logInfo("ssh.auth.passwordPrompt.received", {
      ...sshTargetLogFields(target),
      attempt,
    });

    return password;
  });

  const handleSshAuthFailure = Effect.fn("ssh/tunnel.runWithSshAuthAttempt.handleFailure")(
    function* <T>(
      input: SshAuthAttemptInput<T> & {
        readonly error: SshEnvironmentEffectError;
      },
    ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
      if (!isSshAuthFailure(input.error)) {
        return yield* input.error;
      }

      yield* Effect.logWarning("ssh.auth.failed", {
        ...sshTargetLogFields(input.target),
        key: input.key,
        promptCount: input.promptCount,
        cause: input.error,
      });
      const promptService = yield* SshPasswordPrompt;

      if (!promptService.isAvailable) {
        return yield* input.error;
      }

      if (input.authSecret !== null) {
        authSecrets.delete(input.key);
      }

      if (input.promptCount >= 2) {
        return yield* input.error;
      }

      const nextPromptCount = input.promptCount + 1;
      const nextAuthSecret = yield* promptForPassword(input.target, nextPromptCount);
      authSecrets.set(input.key, nextAuthSecret);

      return yield* runWithSshAuthAttempt({
        ...input,
        promptCount: nextPromptCount,
        authSecret: nextAuthSecret,
      });
    },
  );

  const runWithSshAuthAttempt = Effect.fn("ssh/tunnel.runWithSshAuthAttempt")(function* <T>(
    input: SshAuthAttemptInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const promptService = yield* SshPasswordPrompt;

    const authOptions =
      input.authSecret === null
        ? {
            batchMode: promptService.isAvailable ? ("yes" as const) : ("no" as const),
            interactiveAuth: !promptService.isAvailable,
          }
        : {
            authSecret: input.authSecret,
            batchMode: "no" as const,
            interactiveAuth: true,
          };

    return yield* input
      .operation(authOptions)
      .pipe(Effect.catch((error) => handleSshAuthFailure({ ...input, error })));
  });

  const runWithSshAuth = Effect.fn("ssh/tunnel.runWithSshAuth")(function* <T>(
    input: SshAuthOperationInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    return yield* runWithSshAuthAttempt({
      ...input,
      promptCount: 0,
      authSecret: authSecrets.get(input.key) ?? null,
    });
  });

  const createTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry.create")(function* (input: {
    readonly key: string;
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly runner?: RemoteT3RunnerOptions;
  }): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logDebug("ssh.environment.tunnel.create.start", {
      ...sshTargetLogFields(input.resolvedTarget),
      ...sshRunnerLogFields(input.runner),
      key: input.key,
    });

    const remoteLaunch = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        launchOrReuseRemoteServer(input.resolvedTarget, authOptions, input.runner),
    });

    const remotePort = remoteLaunch.remotePort;
    yield* Effect.logDebug("ssh.environment.remotePort.ready", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      remotePort,
      remoteServerKind: remoteLaunch.remoteServerKind,
    });
    const localPort = yield* reserveLocalTunnelPort();
    const httpBaseUrl = `http://127.0.0.1:${localPort}/`;
    const wsBaseUrl = `ws://127.0.0.1:${localPort}/`;
    yield* Effect.logDebug("ssh.environment.localPort.reserved", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    const entryScope = yield* Scope.make("sequential");

    const tunnelEntry = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        startSshTunnel({
          key: input.key,
          resolvedTarget: input.resolvedTarget,
          remotePort,
          localPort,
          httpBaseUrl,
          wsBaseUrl,
          authOptions,
          remoteServerKind: remoteLaunch.remoteServerKind,
        }).pipe(Effect.provideService(Scope.Scope, entryScope)),
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(entryScope, Exit.void).pipe(Effect.ignore),
      ),
    );

    tunnels.set(input.key, tunnelEntry);
    const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystemService = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    yield* Scope.addFinalizer(
      entryScope,
      Effect.gen(function* () {
        const stopRemote = tunnels.get(tunnelEntry.key) === tunnelEntry;

        if (stopRemote) {
          tunnels.delete(tunnelEntry.key);
        }

        yield* tunnelEntry.process
          .kill({
            killSignal: "SIGTERM",
            forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
          })
          .pipe(Effect.ignore);

        if (!stopRemote) {
          return;
        }

        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.start", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
        const authSecret = authSecrets.get(tunnelEntry.key) ?? null;
        yield* stopRemoteServer(
          tunnelEntry.target,
          authSecret === null
            ? {
                batchMode: "yes",
                interactiveAuth: false,
              }
            : {
                authSecret,
                batchMode: "no",
                interactiveAuth: true,
              },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawnerService),
          Effect.provideService(FileSystem.FileSystem, fileSystemService),
          Effect.provideService(Path.Path, pathService),
        );
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.succeeded", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
      }).pipe(Effect.ignore),
    );
    yield* Effect.logDebug("ssh.environment.tunnel.create.succeeded", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });

    return tunnelEntry;
  });

  const ensureTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry")(function* (
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    runner?: RemoteT3RunnerOptions,
  ): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const entry = tunnels.get(key) ?? null;

    if (entry !== null) {
      yield* Effect.logDebug("ssh.environment.tunnel.existing.check", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
      });

      const readinessExit = yield* Effect.exit(
        waitForHttpReady({ baseUrl: entry.httpBaseUrl, timeoutMs: 2_000 }),
      );

      if (Exit.isSuccess(readinessExit)) {
        yield* Effect.logDebug("ssh.environment.tunnel.reused", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
        });

        return entry;
      }

      yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
        cause: readinessExit.cause,
      });
      yield* closeTunnelEntry(entry);
    }

    return yield* createTunnelEntry({
      key,
      resolvedTarget,
      ...(runner === undefined ? {} : { runner }),
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("ssh.environment.tunnel.create.failed", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          cause,
        }),
      ),
    );
  });

  const ensureEnvironment = Effect.fn("ssh/tunnel.ensureEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    requestOptions?: { readonly issuePairingToken?: boolean },
  ): Effect.fn.Return<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    yield* Effect.logInfo("ssh.environment.ensure.start", {
      ...sshTargetLogFields(target),
      issuePairingToken: requestOptions?.issuePairingToken === true,
    });

    return yield* withTargetLock(
      targetConnectionKey(target),
      Effect.gen(function* () {
        const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);

        const resolvedTarget: DesktopSshEnvironmentTarget = {
          ...baseResolved,
          ...(target.username !== null ? { username: target.username } : {}),
          ...(target.port !== null ? { port: target.port } : {}),
        };

        const key = targetConnectionKey(resolvedTarget);
        yield* Effect.logDebug("ssh.environment.target.resolved", {
          ...sshTargetLogFields(resolvedTarget),
          key,
        });
        const packageSpec = options.resolveCliPackageSpec?.();

        const runner =
          options.resolveCliRunner === undefined
            ? packageSpec === undefined
              ? undefined
              : { packageSpec }
            : yield* options.resolveCliRunner;

        yield* Effect.logDebug("ssh.environment.runner.resolved", {
          ...sshTargetLogFields(resolvedTarget),
          ...sshRunnerLogFields(runner),
          key,
        });
        const entry = yield* ensureTunnelEntry(key, resolvedTarget, runner);

        const pairingResult = requestOptions?.issuePairingToken
          ? yield* runWithSshAuth({
              key,
              target: entry.target,
              operation: (authOptions) =>
                issueRemotePairingToken(entry.target, authOptions, runner),
            })
          : null;

        const pairingToken = pairingResult?.credential ?? null;

        yield* Effect.logInfo("ssh.environment.ensure.succeeded", {
          ...sshTargetLogFields(entry.target),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
          remoteServerKind: entry.remoteServerKind,
          issuedPairingToken: pairingToken !== null,
        });

        return {
          target: entry.target,
          httpBaseUrl: entry.httpBaseUrl,
          wsBaseUrl: entry.wsBaseUrl,
          pairingToken,
          remotePort: entry.remotePort,
          ...(entry.remoteServerKind ? { remoteServerKind: entry.remoteServerKind } : {}),
        };
      }),
    );
  });

  const disconnectEnvironment = Effect.fn("ssh/tunnel.disconnectEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<void, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logInfo("ssh.environment.disconnect.start", sshTargetLogFields(target));
    yield* withTargetLock(
      targetConnectionKey(target),
      Effect.gen(function* () {
        const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);

        const resolvedTarget: DesktopSshEnvironmentTarget = {
          ...baseResolved,
          ...(target.username !== null ? { username: target.username } : {}),
          ...(target.port !== null ? { port: target.port } : {}),
        };

        const key = targetConnectionKey(resolvedTarget);
        const entry = tunnels.get(key) ?? null;
        yield* Effect.logDebug("ssh.environment.disconnect.targetResolved", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          hasTunnel: entry !== null,
        });

        if (entry !== null) {
          // Explicit disconnect owns the remote stop so its failure reaches the caller.
          yield* Effect.gen(function* () {
            tunnels.delete(key);
            yield* closeTunnelEntry(entry);
          }).pipe(Effect.uninterruptible);
        }

        yield* runWithSshAuth({
          key,
          target: resolvedTarget,
          operation: (authOptions) => stopRemoteServer(resolvedTarget, authOptions),
        });
        yield* Effect.logInfo("ssh.environment.disconnect.succeeded", {
          ...sshTargetLogFields(resolvedTarget),
          key,
        });
      }),
    );
  });

  return SshEnvironmentManager.of({ ensureEnvironment, disconnectEnvironment });
});

/**
 * @effect-expect-leaking ChildProcessSpawner | FileSystem | HttpClient | NetService | Path | SshPasswordPrompt
 */
export class SshEnvironmentManager extends Context.Service<
  SshEnvironmentManager,
  SshEnvironmentManagerShape
>()("@akeru/ssh/tunnel/SshEnvironmentManager") {
  static readonly layer = (options: SshEnvironmentManagerOptions = {}) =>
    Layer.effect(SshEnvironmentManager, makeSshEnvironmentManager(options));
}

export {
  DEFAULT_REMOTE_PORT,
  type RemoteT3RunnerOptions,
  type SshEnvironmentManagerOptions,
  type SshEnvironmentManagerShape,
  normalizeSshErrorMessage,
} from "./types.ts";

export {
  launchOrReuseRemoteServer,
  issueRemotePairingToken,
  stopRemoteServer,
} from "./remoteServer.ts";

export {
  REMOTE_PICK_PORT_SCRIPT,
  REMOTE_WAIT_READY_SCRIPT,
  REMOTE_NODE_ENV_SCRIPT,
  REMOTE_RUNNER_SCRIPT,
  REMOTE_LAUNCH_SCRIPT,
  REMOTE_PAIRING_SCRIPT,
  REMOTE_STOP_SCRIPT,
  buildRemoteT3RunnerScript,
  buildRemoteNodeEnvScript,
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteStopScript,
} from "./remoteScripts.ts";

export { waitForHttpReady, resolveLoopbackSshHttpBaseUrl } from "./readiness.ts";
