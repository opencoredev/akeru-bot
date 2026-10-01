// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import {
  makePackageManagedProviderMaintenanceResolver,
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  normalizeCommandPath,
} from "../providerMaintenance.ts";

export function makeproviderMaintenanceTestSupport() {
  const driver = (value: string) => ProviderDriverKind.make(value);

  const makeTempDir = (name: string) =>
    Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
      Effect.map((id) => NodePath.join(NodeOS.tmpdir(), `${name}-${id}`)),
    );

  const isNativeTestCommandPath =
    (expectedPathSegment: string) =>
    (commandPath: string): boolean =>
      normalizeCommandPath(commandPath).includes(expectedPathSegment);

  const packageToolUpdate = makePackageManagedProviderMaintenanceResolver({
    provider: driver("packageTool"),
    npmPackageName: "@example/package-tool",
    homebrewFormula: "package-tool",
    nativeUpdate: null,
  });

  const nativePackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
    provider: driver("nativePackageTool"),
    npmPackageName: "@example/native-package-tool",
    homebrewFormula: "native-package-tool",
    nativeUpdate: {
      executable: "native-package-tool",
      args: ["update"],
      lockKey: "native-package-tool-native",
      isCommandPath: isNativeTestCommandPath("/.local/bin/native-package-tool"),
    },
  });

  const scopedPackageToolUpdate = makePackageManagedProviderMaintenanceResolver({
    provider: driver("scopedPackageTool"),
    npmPackageName: "@example/scoped-package-tool",
    homebrewFormula: "example/tap/scoped-package-tool",
    nativeUpdate: {
      executable: "scoped-package-tool",
      args: ["upgrade"],
      lockKey: "scoped-package-tool-native",
      isCommandPath: isNativeTestCommandPath("/.scoped-package-tool/bin/scoped-package-tool"),
    },
  });

  const staticToolUpdate = makeStaticProviderMaintenanceResolver(
    makeProviderMaintenanceCapabilities({
      provider: driver("staticTool"),
      packageName: null,
      updateExecutable: "static-tool",
      updateArgs: ["update"],
      updateLockKey: "static-tool",
    }),
  );

  const installedPackageToolProvider: ServerProvider = {
    instanceId: ProviderInstanceId.make("packageTool"),
    driver: driver("packageTool"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-04-10T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return {
    driver,
    makeTempDir,
    isNativeTestCommandPath,
    packageToolUpdate,
    nativePackageToolUpdate,
    scopedPackageToolUpdate,
    staticToolUpdate,
    installedPackageToolProvider,
  };
}
