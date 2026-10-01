import * as Predicate from "effect/Predicate";
import { describe } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off
import { it, assert } from "@effect/vitest";
import { ProviderInstanceId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessEnvironment, HostProcessPlatform } from "@akeru/shared/hostProcess";
import { SpawnExecutableResolution } from "@akeru/shared/shell";
import { providerMaintenanceCapabilities } from "./providerMaintenance.ts";
import { makeproviderMaintenanceRunnerTestSupport } from "./test-support/providerMaintenanceRunner.ts";

const {
  CODEX_DRIVER,
  NonWindowsPlatform,
  baseProvider,
  latestVersionHttpClient,
  mockHandle,
  mockSpawnerLayer,
  makeRegistry,
  makeTestRunner,
} = makeproviderMaintenanceRunnerTestSupport();

describe("providerMaintenanceRunner", () => {
  it.effect("updates a single provider instance without touching sibling instances", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const personalInstanceId = ProviderInstanceId.make("codex_personal");
      const workInstanceId = ProviderInstanceId.make("codex_work");
      const refreshedInstanceIds: Array<ProviderInstanceId> = [];

      const { registry } = yield* makeRegistry([
        {
          ...baseProvider,
          instanceId: personalInstanceId,
          version: "0.124.0-alpha.3",
        },
        {
          ...baseProvider,
          instanceId: workInstanceId,
          version: "0.124.0-alpha.3",
        },
      ]);

      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (instanceId, provider) =>
          Effect.succeed(
            providerMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex-instance-test",
              updateExecutable: "vp",
              updateArgs: ["i", "-g", "@openai/codex"],
              updateLockKey: "vite-plus-global",
            }),
          ).pipe(
            Effect.tap(() => Effect.sync(() => assert.strictEqual(instanceId, personalInstanceId))),
          ),
        refreshInstance: (instanceId) =>
          registry.refreshInstance(instanceId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                refreshedInstanceIds.push(instanceId);
              }),
            ),
          ),
      });

      const result = yield* updater.updateProvider({
        provider: CODEX_DRIVER,
        instanceId: personalInstanceId,
      });

      assert.deepStrictEqual(calls, [
        {
          command: "vp",
          args: ["i", "-g", "@openai/codex"],
        },
      ]);
      assert.deepStrictEqual(refreshedInstanceIds, [personalInstanceId]);
      assert.strictEqual(result.providers[0]?.instanceId, personalInstanceId);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.strictEqual(result.providers[1]?.instanceId, workInstanceId);
      assert.strictEqual(result.providers[1]?.updateState, undefined);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.124.0-alpha.3"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });

            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("resolves npm to a .cmd shim and routes through the shell on win32", () => {
    const captured: Array<{
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly shell: boolean | string | undefined;
    }> = [];

    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);
      const runner = yield* makeTestRunner(registry);

      const result = yield* runner.updateProvider(CODEX_DRIVER);

      // On win32, resolveSpawnCommand resolves `npm` to the `.cmd` shim and
      // routes the spawn through cmd.exe (shell: true), escaping every arg.
      assert.strictEqual(captured.length, 1);
      const call = captured[0];
      assert.ok(call, "expected the spawner to be invoked once");
      // The resolved command is the escaped `.cmd` path. Asserting the precise
      // escaped string is brittle, so verify it carries the resolved shim and
      // that shell mode was used.
      assert.match(call.command, /npm\.cmd/i);
      assert.strictEqual(call.shell, true);
      // Args are escaped for cmd.exe shell mode (each quoted) but still carry
      // the original install command (`install -g @openai/codex@latest`) in order.
      assert.strictEqual(call.args.length, 3);
      assert.match(call.args[0] ?? "", /install/);
      assert.match(call.args[1] ?? "", /-g/);
      assert.match(call.args[2] ?? "", /@openai\/codex@latest/);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HostProcessPlatform, "win32"),
          Layer.succeed(HostProcessEnvironment, {
            PATH: "C:\\fake\\npm",
            PATHEXT: ".COM;.EXE;.BAT;.CMD",
          }),
          Layer.succeed(SpawnExecutableResolution, (command) =>
            command === "npm" ? "C:\\fake\\npm\\npm.cmd" : undefined,
          ),
          latestVersionHttpClient("0.0.0"),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              if (!Predicate.isTagged(command, "StandardCommand"))
                return Effect.die(new Error("Expected a standard command."));
              const childProcess = command;

              captured.push({
                command: childProcess.command,
                args: childProcess.args,
                shell: childProcess.options.shell,
              });

              return Effect.succeed(mockHandle({ stdout: "updated" }));
            }),
          ),
        ),
      ),
    );
  });
});
