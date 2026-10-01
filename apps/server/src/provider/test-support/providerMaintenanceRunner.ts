// @effect-diagnostics nodeBuiltinImport:off
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@akeru/contracts";
import { ServerProviderUpdateError } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "../providerMaintenanceRunner.ts";
import {
  makeProviderMaintenanceCapabilities,
  ProviderVersionCache,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

export function makeproviderMaintenanceRunnerTestSupport() {
  const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

  const CODEX_DRIVER = ProviderDriverKind.make("codex");

  const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

  const OPENCODE_DRIVER = ProviderDriverKind.make("opencode");

  const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");

  const CURSOR_INSTANCE_ID = ProviderInstanceId.make("cursor");

  const OPENCODE_INSTANCE_ID = ProviderInstanceId.make("opencode");

  const encoder = new TextEncoder();

  // Pin a non-win32 platform so `resolveSpawnCommand` is a no-op and the raw
  // `{ command, args }` assertions below hold deterministically on any host
  // (including Windows). Windows-specific resolution is covered by the dedicated
  // win32 case at the end of this suite.
  const NonWindowsPlatform = Layer.succeed(HostProcessPlatform, "linux");

  function lifecycleFor(provider: ProviderDriverKind): ProviderMaintenanceCapabilities {
    if (provider === CURSOR_DRIVER) {
      return makeProviderMaintenanceCapabilities({
        provider,
        packageName: null,
        updateExecutable: "cursor-agent",
        updateArgs: ["update"],
        updateLockKey: "cursor-agent",
      });
    }

    return makeProviderMaintenanceCapabilities({
      provider,
      packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
      updateExecutable: "npm",
      updateArgs:
        provider === OPENCODE_DRIVER
          ? ["install", "-g", "opencode-ai@latest"]
          : ["install", "-g", "@openai/codex@latest"],
      updateLockKey: "npm-global",
    });
  }

  const baseProvider: ServerProvider = {
    instanceId: CODEX_INSTANCE_ID,
    driver: CODEX_DRIVER,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-10T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };

  const baseCursorProvider: ServerProvider = {
    ...baseProvider,
    instanceId: CURSOR_INSTANCE_ID,
    driver: CURSOR_DRIVER,
  };

  const baseOpenCodeProvider: ServerProvider = {
    ...baseProvider,
    instanceId: OPENCODE_INSTANCE_ID,
    driver: OPENCODE_DRIVER,
  };

  const latestVersionHttpClient = (version: string) =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ version }, { headers: { "content-type": "application/json" } }),
          ),
        ),
      ),
    );

  function mockHandle(result: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly code?: number;
    readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  }) {
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: result.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: Stream.make(encoder.encode(result.stdout ?? "")),
      stderr: Stream.make(encoder.encode(result.stderr ?? "")),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  }

  function mockSpawnerLayer(
    handler: (
      command: string,
      args: ReadonlyArray<string>,
    ) => {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code?: number;
      readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
    },
  ) {
    return Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const childProcess = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };

        return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
      }),
    );
  }

  function makeRegistry(
    initialProviders: ServerProvider | ReadonlyArray<ServerProvider> = baseProvider,
  ) {
    return Effect.gen(function* () {
      const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
        Array.isArray(initialProviders) ? initialProviders : [initialProviders],
      );

      const updateStatesRef = yield* Ref.make<ReadonlyArray<ServerProviderUpdateState>>([]);

      const setProviderMaintenanceActionState = Effect.fn(
        "providerMaintenanceRunner.test.setProviderMaintenanceActionState",
      )(function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly action: "update";
        readonly state: ServerProviderUpdateState | null;
      }) {
        const updateState = input.state;

        if (updateState) {
          yield* Ref.update(updateStatesRef, (states) => [...states, updateState]);
        }

        return yield* Ref.updateAndGet(providersRef, (providers) =>
          providers.map((candidate) => {
            if (candidate.instanceId !== input.instanceId) {
              return candidate;
            }

            if (!updateState) {
              const { updateState: _updateState, ...providerWithoutUpdateState } = candidate;

              return providerWithoutUpdateState;
            }

            return {
              ...candidate,
              updateState,
            };
          }),
        );
      });

      const registry: ProviderRegistryShape = {
        getProviders: Ref.get(providersRef),
        refresh: () => Ref.get(providersRef),
        refreshInstance: () => Ref.get(providersRef),
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(lifecycleFor(provider)),
        setProviderMaintenanceActionState,
        streamChanges: Stream.empty,
      };

      return {
        registry,
        updateStatesRef,
      };
    });
  }

  const makeTestRunner = (registry: ProviderRegistryShape) =>
    Effect.service(ProviderMaintenanceRunner.ProviderMaintenanceRunner).pipe(
      Effect.provide(
        ProviderMaintenanceRunner.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProviderRegistry, registry),
              Layer.succeed(ProviderVersionCache, new Map()),
            ),
          ),
        ),
      ),
    );

  return {
    isServerProviderUpdateError,
    CODEX_DRIVER,
    CURSOR_DRIVER,
    OPENCODE_DRIVER,
    CODEX_INSTANCE_ID,
    CURSOR_INSTANCE_ID,
    OPENCODE_INSTANCE_ID,
    encoder,
    NonWindowsPlatform,
    lifecycleFor,
    baseProvider,
    baseCursorProvider,
    baseOpenCodeProvider,
    latestVersionHttpClient,
    mockHandle,
    mockSpawnerLayer,
    makeRegistry,
    makeTestRunner,
  };
}
