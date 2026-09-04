import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { getDefaultBuildArch } from "./build-target-arch.ts";

const withHostRuntime = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  env: Record<string, string> = {},
) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(HostProcessPlatform, platform),
      Layer.succeed(HostProcessArchitecture, arch),
      ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    ),
  );

describe("build-target-arch", () => {
  it.effect("uses the resolved host arch when selecting the default Windows build arch", () =>
    Effect.gen(function* () {
      // This mirrors the packaging script's default-path behavior: the current
      // process is x64, but the machine itself is ARM64, so the default build
      // target should be win-arm64 rather than win-x64.
      const arch = yield* getDefaultBuildArch(["x64", "arm64"]).pipe(
        withHostRuntime("win32", "x64", {
          PROCESSOR_ARCHITECTURE: "AMD64", // The currently running Node process is x64.
          PROCESSOR_ARCHITEW6432: "ARM64", // The process is x64, but the actual Windows host is ARM64.
        }),
      );

      assert.equal(arch, "arm64");
    }),
  );

  it.effect("uses x64 when Windows architecture variables are absent", () =>
    Effect.gen(function* () {
      const arch = yield* getDefaultBuildArch(["arm64", "x64"]).pipe(
        withHostRuntime("win32", "x64"),
      );

      assert.equal(arch, "x64");
    }),
  );

  it.effect("uses the first supported architecture when the host is unsupported", () =>
    Effect.gen(function* () {
      const arch = yield* getDefaultBuildArch(["arm64", "universal"]).pipe(
        withHostRuntime("darwin", "x64"),
      );

      assert.equal(arch, "arm64");
    }),
  );

  it.effect("uses x64 when no architectures are configured", () =>
    Effect.gen(function* () {
      const arch = yield* getDefaultBuildArch([]).pipe(withHostRuntime("darwin", "arm64"));

      assert.equal(arch, "x64");
    }),
  );

  it.effect("does not apply Windows host env heuristics on non-Windows hosts", () =>
    Effect.gen(function* () {
      const arch = yield* getDefaultBuildArch(["x64", "arm64"]).pipe(
        withHostRuntime("linux", "x64", {
          PROCESSOR_ARCHITECTURE: "AMD64",
          PROCESSOR_ARCHITEW6432: "ARM64",
        }),
      );

      assert.equal(arch, "x64");
    }),
  );
});
