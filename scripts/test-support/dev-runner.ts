import * as NetService from "@akeru/shared/Net";

import * as ConfigProvider from "effect/ConfigProvider";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as PlatformError from "effect/PlatformError";

import * as Sink from "effect/Sink";

import * as Stream from "effect/Stream";

import { ChildProcessSpawner } from "effect/unstable/process";

export const emptyConfigLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));

export const netServiceLayer = Layer.succeed(NetService.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(49_152),
  findAvailablePort: (port) => Effect.succeed(port),
});

export function mockProcess(exit: number | PlatformError.PlatformError) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode:
      typeof exit === "number"
        ? Effect.succeed(ChildProcessSpawner.ExitCode(exit))
        : Effect.fail(exit),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

export const devServerInput = {
  mode: "dev:server",
  t3Home: "/tmp/t3code-dev-runner",
  browser: undefined,
  autoBootstrapProjectFromCwd: undefined,
  logWebSocketEvents: undefined,
  host: undefined,
  port: 13_773,
  devUrl: undefined,
  dryRun: false,
  share: false,
  runArgs: ["--inspect", "secret-token-value"],
} as const;
