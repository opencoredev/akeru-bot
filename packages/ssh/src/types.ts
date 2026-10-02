import type { DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentTarget } from "@akeru/contracts";
import * as NetService from "@akeru/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { type SshAuthOptions, SshPasswordPrompt } from "./auth.ts";
import {
  SshCommandError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

export const DEFAULT_REMOTE_PORT = 3773;

export const REMOTE_PORT_SCAN_WINDOW = 200;

export const SSH_READY_TIMEOUT_MS = 20_000;

export const SSH_READY_PROBE_TIMEOUT_MS = 1_000;

export const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;

export const REMOTE_READY_TIMEOUT_MS = 60_000;

export const REMOTE_LAUNCH_TIMEOUT_MS = 90_000;

export const REMOTE_REUSE_READY_TIMEOUT_MS = 2_000;

export interface RemoteT3RunnerOptions {
  readonly packageSpec?: string;
  readonly nodeScriptPath?: string | null;
  readonly nodeEngineRange?: string | null;
}

export interface SshEnvironmentManagerOptions {
  readonly resolveCliPackageSpec?: () => string;
  readonly resolveCliRunner?: Effect.Effect<RemoteT3RunnerOptions>;
}

export interface SshTunnelEntry {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Scope;
}

export type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SshPasswordPrompt;

export type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

export function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

export function sshRunnerLogFields(runner: RemoteT3RunnerOptions | undefined) {
  if (runner?.nodeScriptPath?.trim()) {
    return { runner: "node-script", nodeScriptPath: runner.nodeScriptPath.trim() };
  }

  if (runner?.packageSpec?.trim()) {
    return { runner: "package", packageSpec: runner.packageSpec.trim() };
  }

  return { runner: "default" };
}

export interface SshAuthOperationInput<T> {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

export interface SshAuthAttemptInput<T> extends SshAuthOperationInput<T> {
  readonly promptCount: number;
  readonly authSecret: string | null;
}

export interface SshEnvironmentManagerShape {
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) => Effect.Effect<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

export function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();

  return cleaned.length > 0 ? cleaned : fallbackMessage;
}
