import { describe } from "vite-plus/test";
import { it, assert } from "@effect/vitest";
import { type ServerProvider } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { providerMaintenanceCapabilities } from "./providerMaintenance.ts";
import { makeproviderMaintenanceRunnerTestSupport } from "./test-support/providerMaintenanceRunner.ts";

const {
  isServerProviderUpdateError,
  CODEX_DRIVER,
  OPENCODE_DRIVER,
  OPENCODE_INSTANCE_ID,
  NonWindowsPlatform,
  baseProvider,
  baseOpenCodeProvider,
  latestVersionHttpClient,
  mockSpawnerLayer,
  makeRegistry,
  makeTestRunner,
} = makeproviderMaintenanceRunnerTestSupport();

describe("providerMaintenanceRunner", () => {
  it.effect("prevents concurrent updates for the same provider", () => {
    const startedLatch = { resolve: () => {} };
    const releaseLatch = { resolve: () => {} };

    const started = new Promise<void>((resolve) => {
      startedLatch.resolve = resolve;
    });

    const release = new Promise<void>((resolve) => {
      releaseLatch.resolve = resolve;
    });

    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started);

      const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
      assert.strictEqual(Exit.isFailure(second), true);

      if (Exit.isFailure(second)) {
        const error = Cause.squash(second.cause);
        assert.strictEqual(isServerProviderUpdateError(error), true);

        if (isServerProviderUpdateError(error)) {
          assert.include(error.reason, "already running");
        }
      }

      releaseLatch.resolve();
      yield* Fiber.join(first);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => {
            startedLatch.resolve();

            return {
              stdout: "updated",
              exitCode: Effect.promise(() => release).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
            };
          }),
        ),
      ),
    );
  });

  it.effect("serializes different providers that share the same update lock key", () => {
    const firstStartedLatch = { resolve: () => {} };
    const releaseFirstLatch = { resolve: () => {} };

    const firstStarted = new Promise<void>((resolve) => {
      firstStartedLatch.resolve = resolve;
    });

    const releaseFirst = new Promise<void>((resolve) => {
      releaseFirstLatch.resolve = resolve;
    });

    const calls: Array<string> = [];

    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry([baseProvider, baseOpenCodeProvider]);

      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            providerMaintenanceCapabilities({
              provider,
              packageName: provider === OPENCODE_DRIVER ? "opencode-ai" : "@openai/codex",
              updateExecutable: "npm",
              updateArgs:
                provider === OPENCODE_DRIVER
                  ? ["install", "-g", "opencode-ai@latest"]
                  : ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "npm-global",
            }),
          ),
      });

      const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
      yield* Effect.promise(() => firstStarted);

      const second = yield* updater.updateProvider(OPENCODE_DRIVER).pipe(Effect.forkScoped);
      let providersWhileQueued: ReadonlyArray<ServerProvider> = [];

      for (let attempt = 0; attempt < 20; attempt += 1) {
        providersWhileQueued = yield* registry.getProviders;

        const queuedStatus = providersWhileQueued.find(
          (provider) => provider.instanceId === OPENCODE_INSTANCE_ID,
        )?.updateState?.status;

        if (queuedStatus === "queued") {
          break;
        }

        yield* Effect.yieldNow;
      }

      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
      assert.strictEqual(
        providersWhileQueued.find((provider) => provider.instanceId === OPENCODE_INSTANCE_ID)
          ?.updateState?.status,
        "queued",
      );

      releaseFirstLatch.resolve();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepStrictEqual(calls, [
        "install -g @openai/codex@latest",
        "install -g opencode-ai@latest",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((_command, args) => {
            calls.push(args.join(" "));

            if (calls.length === 1) {
              firstStartedLatch.resolve();

              return {
                stdout: "updated",
                exitCode: Effect.promise(() => releaseFirst).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              };
            }

            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("accepts arbitrary driver-provided update lock keys", () => {
    const calls: Array<string> = [];

    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry(baseProvider);

      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
          Effect.succeed(
            providerMaintenanceCapabilities({
              provider,
              packageName: "@openai/codex",
              updateExecutable: "npm",
              updateArgs: ["install", "-g", "@openai/codex@latest"],
              updateLockKey: "unknown-lock-key",
            }),
          ),
      });

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(calls, ["install -g @openai/codex@latest"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((_command, args) => {
            calls.push(args.join(" "));

            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "releases the running-provider marker when interrupted after queuing but before the lock run starts",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        let blockQueuedState = true;
        const queuedStateWrittenLatch = { resolve: () => {} };
        const releaseQueuedStateLatch = { resolve: () => {} };

        const queuedStateWritten = new Promise<void>((resolve) => {
          queuedStateWrittenLatch.resolve = resolve;
        });

        const releaseQueuedState = new Promise<void>((resolve) => {
          releaseQueuedStateLatch.resolve = resolve;
        });

        const updater = yield* makeTestRunner({
          ...registry,
          setProviderMaintenanceActionState: Effect.fn(
            "providerMaintenanceRunner.test.blockQueuedState",
          )(function* (input) {
            const providers = yield* registry.setProviderMaintenanceActionState(input);

            if (input.state?.status === "queued" && blockQueuedState) {
              queuedStateWrittenLatch.resolve();
              yield* Effect.promise(() => releaseQueuedState);
            }

            return providers;
          }),
        });

        const first = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.forkScoped);
        yield* Effect.promise(() => queuedStateWritten);
        blockQueuedState = false;

        yield* Fiber.interrupt(first);
        releaseQueuedStateLatch.resolve();

        const second = yield* updater.updateProvider(CODEX_DRIVER).pipe(Effect.exit);
        assert.strictEqual(Exit.isSuccess(second), true);

        if (Exit.isSuccess(second)) {
          assert.strictEqual(second.value.providers[0]?.updateState?.status, "succeeded");
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NonWindowsPlatform,
            latestVersionHttpClient("0.0.0"),
            mockSpawnerLayer(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );
});
