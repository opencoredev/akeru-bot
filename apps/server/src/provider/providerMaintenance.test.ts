import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";
import {
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  ProviderVersionCache,
  resolveLatestProviderVersion,
} from "./providerMaintenance.ts";
import { makeproviderMaintenanceTestSupport } from "./test-support/providerMaintenance.ts";

const {
  driver,
  packageToolUpdate,
  nativePackageToolUpdate,
  staticToolUpdate,
  installedPackageToolProvider,
} = makeproviderMaintenanceTestSupport();

it.layer(NodeServices.layer)("providerMaintenance", (it) => {
  it.effect("reads cached versions through the injectable cache reference", () =>
    resolveLatestProviderVersion(packageToolUpdate.resolve()).pipe(
      Effect.provideService(
        ProviderVersionCache,
        new Map([
          [
            "@example/package-tool",
            {
              expiresAt: Number.MAX_SAFE_INTEGER,
              version: "9.9.9",
            },
          ],
        ]),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("cached provider version should not make an HTTP request"),
        ),
      ),
      Effect.map((version) => {
        expect(version).toBe("9.9.9");
      }),
    ),
  );

  it.effect("does not fetch latest provider versions when update checks are disabled", () =>
    enrichProviderSnapshotWithVersionAdvisory(
      installedPackageToolProvider,
      packageToolUpdate.resolve(),
      {
        enableProviderUpdateChecks: false,
      },
    ).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.die("disabled provider update checks should not make an HTTP request"),
        ),
      ),
      Effect.map((provider) => {
        expect(provider.versionAdvisory).toMatchObject({
          status: "unknown",
          currentVersion: "1.0.0",
          latestVersion: null,
          checkedAt: "2026-04-10T00:00:00.000Z",
        });
      }),
    ),
  );

  it("marks providers with unknown current versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: null,
        latestVersion: "9.9.9",
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: null,
      latestVersion: "9.9.9",
    });
  });

  it("marks providers with unknown latest versions as unknown", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("packageTool"),
        currentVersion: "1.0.0",
        latestVersion: null,
      }),
    ).toMatchObject({
      status: "unknown",
      currentVersion: "1.0.0",
      latestVersion: null,
      message: null,
    });
  });

  it("marks installed providers behind latest when a newer provider version is available", () => {
    expect(
      createProviderVersionAdvisory({
        driver: driver("nativePackageTool"),
        currentVersion: "2.1.110",
        latestVersion: "2.1.117",
        maintenanceCapabilities: nativePackageToolUpdate.resolve(),
      }),
    ).toMatchObject({
      status: "behind_latest",
      currentVersion: "2.1.110",
      latestVersion: "2.1.117",
      updateCommand:
        "npm install -g --allow-scripts=@example/native-package-tool @example/native-package-tool@latest",
      canUpdate: true,
      message: "Install the update now or review provider settings.",
    });
  });

  it("keeps update commands owned by provider maintenance capabilities", () => {
    expect(staticToolUpdate.resolve()).toEqual({
      provider: driver("staticTool"),
      packageName: null,
      update: {
        command: "static-tool update",

        executable: "static-tool",

        args: ["update"],

        lockKey: "static-tool",
      },
    });
  });
});
