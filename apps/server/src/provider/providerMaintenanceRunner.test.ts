import { describe } from "vite-plus/test";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { providerMaintenanceCapabilities } from "./providerMaintenance.ts";
import { makeproviderMaintenanceRunnerTestSupport } from "./test-support/providerMaintenanceRunner.ts";

const {
  CODEX_DRIVER,
  CURSOR_DRIVER,
  NonWindowsPlatform,
  baseProvider,
  baseCursorProvider,
  latestVersionHttpClient,
  mockSpawnerLayer,
  makeRegistry,
  makeTestRunner,
} = makeproviderMaintenanceRunnerTestSupport();

describe("providerMaintenanceRunner", () => {
  it.effect("runs the allowlisted provider update command and records success", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const { registry, updateStatesRef } = yield* makeRegistry(baseCursorProvider);
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CURSOR_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "cursor-agent",
          args: ["update"],
        },
      ]);
      assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      assert.deepStrictEqual(
        (yield* Ref.get(updateStatesRef)).map((state) => state.status),
        ["queued", "running", "succeeded"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });

            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect("uses the resolved provider capabilities when choosing the update executable", () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const { registry } = yield* makeRegistry({
        ...baseProvider,
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "2.0.14",
          latestVersion: "2.1.123",
          updateCommand: "bun i -g @anthropic-ai/claude-code@latest",
          canUpdate: true,
          checkedAt: "2026-04-30T12:00:00.000Z",
          message: "Update available.",
        },
      });

      const updater = yield* makeTestRunner({
        ...registry,
        getProviderMaintenanceCapabilitiesForInstance: () =>
          Effect.succeed(
            providerMaintenanceCapabilities({
              provider: CODEX_DRIVER,
              packageName: "@openai/codex",
              updateExecutable: "bun",
              updateArgs: ["i", "-g", "@openai/codex@latest"],
              updateLockKey: "bun-global",
            }),
          ),
      });

      yield* updater.updateProvider(CODEX_DRIVER);
      assert.deepStrictEqual(calls, [
        {
          command: "bun",
          args: ["i", "-g", "@openai/codex@latest"],
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer((command, args) => {
            calls.push({ command, args });

            return { stdout: "updated" };
          }),
        ),
      ),
    );
  });

  it.effect(
    "runs update commands through Effect ChildProcess when no test runner is injected",
    () => {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

      return Effect.gen(function* () {
        const { registry } = yield* makeRegistry(baseProvider);
        const runner = yield* makeTestRunner(registry);

        const result = yield* runner.updateProvider(CODEX_DRIVER);

        assert.deepStrictEqual(calls, [
          {
            command: "npm",
            args: ["install", "-g", "@openai/codex@latest"],
          },
        ]);
        assert.strictEqual(result.providers[0]?.updateState?.status, "succeeded");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NonWindowsPlatform,
            latestVersionHttpClient("0.0.0"),
            mockSpawnerLayer((command, args) => {
              calls.push({ command, args });

              return { stdout: "updated" };
            }),
          ),
        ),
      );
    },
  );

  it.effect("records command failure output in provider update state", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeRegistry();
      const updater = yield* makeTestRunner(registry);

      const result = yield* updater.updateProvider(CODEX_DRIVER);
      const updateState = result.providers[0]?.updateState;

      assert.strictEqual(updateState?.status, "failed");
      assert.strictEqual(updateState?.message, "Update command exited with code 1.");
      assert.include(updateState?.output ?? "", "permission denied");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NonWindowsPlatform,
          latestVersionHttpClient("0.0.0"),
          mockSpawnerLayer(() => ({ stderr: "permission denied", code: 1 })),
        ),
      ),
    ),
  );

  it.effect(
    "marks successful commands as unchanged when the refreshed provider is still outdated",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* makeRegistry({
          ...baseProvider,
          installed: true,
          version: "0.1.0",
        });

        const updater = yield* makeTestRunner(registry);

        const result = yield* updater.updateProvider(CODEX_DRIVER);

        assert.strictEqual(result.providers[0]?.updateState?.status, "unchanged");
        assert.include(result.providers[0]?.updateState?.message ?? "", "still detects");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NonWindowsPlatform,
            latestVersionHttpClient("9.9.9"),
            mockSpawnerLayer(() => ({ stdout: "updated" })),
          ),
        ),
      ),
  );
});
