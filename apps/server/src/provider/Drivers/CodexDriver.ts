import { CodexSettings, ProviderDriverKind, type ServerProvider } from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeHarnessTextGeneration } from "../../textGeneration/HarnessTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { instanceUsesSavedCredential } from "../../subscription-auth/runtime.ts";
import { ProviderDriverError } from "../Errors.ts";
import { pendingCodexProvider } from "../Layers/CodexProvider.ts";
import { makeHarnessProviderStatus } from "../HarnessProviderStatus.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as ModelCatalog from "../ModelCatalog.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  explicitProviderInstanceEnvironment,
  mergeProviderInstanceEnvironment,
} from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  packageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  providerSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { codexContinuationIdentity, resolveCodexHomeLayout } from "./CodexHomeLayout.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("codex");

const UPDATE = packageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@openai/codex",
  homebrewFormula: "codex",
  nativeUpdate: null,
});

/**
 * Services the driver needs to materialize an instance. Surfaced as the
 * driver's `R` so the registry layer aggregates these across every
 * registered driver and the runtime satisfies them once.
 */
export type CodexDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Stamp instance identity onto a `ServerProvider` snapshot produced by the
 * driver-kind-only codex helpers. Once `buildServerProvider` in
 * `providerSnapshot.ts` is widened to accept `instanceId`/`driver`, this
 * wrapper disappears.
 */
const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const CodexDriver: ProviderDriver<CodexSettings, CodexDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const homeLayout = yield* resolveCodexHomeLayout(config);
      const continuationIdentity = codexContinuationIdentity(homeLayout);

      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      const effectiveConfig = {
        ...config,
        enabled,
        homePath: homeLayout.effectiveHomePath ?? "",
      } satisfies CodexSettings;

      const connection = {
        environment: processEnv,
        instanceEnvironment: explicitProviderInstanceEnvironment(environment),
        useSavedCredential: instanceUsesSavedCredential("openai-codex", {
          driver: DRIVER_KIND,
          environment,
          config,
        }),
      };

      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = undefined;

      const textGeneration = yield* makeHarnessTextGeneration({
        secretsDir: (yield* ServerConfig).secretsDir,
        driver: DRIVER_KIND,
        instanceId,
        connection,
      });

      const checkProvider = (yield* makeHarnessProviderStatus({
        secretsDir: (yield* ServerConfig).secretsDir,
        provider: "openai-codex",
        driver: DRIVER_KIND,
        instanceId,
        connection,
        draft: pendingCodexProvider(effectiveConfig),
      })).checkProvider.pipe(Effect.map(stampIdentity));

      const snapshotSettings = providerSnapshotSettingsSource(effectiveConfig, serverSettings);

      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => checkProvider,
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        mastraConnection: connection,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
