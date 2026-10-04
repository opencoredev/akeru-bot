import { KimiSettings, ProviderDriverKind, type ServerProvider } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import {
  instanceUsesSavedCredential,
  mergeSubscriptionInstanceEnvironment,
} from "../../subscription-auth/runtime.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { explicitProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { defaultProviderContinuationIdentity } from "../ProviderDriver.ts";
import { manualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import * as ModelCatalog from "../ModelCatalog.ts";

const DRIVER_KIND = ProviderDriverKind.make("kimi");

const decodeSettings = Schema.decodeSync(KimiSettings);

const BUILT_IN_MODELS = ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"] as const;

export type KimiDriverEnv =
  | ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | ModelCatalog.ModelCatalog;

export const KimiDriver: ProviderDriver<KimiSettings, KimiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Kimi For Coding", supportsMultipleInstances: true },
  configSchema: KimiSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const auth = yield* SubscriptionAuthService.forSecretsDir(serverConfig.secretsDir);
      const modelCatalog = yield* ModelCatalog.ModelCatalog;

      const changes = yield* Effect.acquireRelease(
        PubSub.unbounded<ServerProvider>(),
        PubSub.shutdown,
      );

      const effectiveEnabled = enabled && config.enabled;
      const processEnv = mergeSubscriptionInstanceEnvironment(environment);

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });

      const readSnapshot = Effect.gen(function* () {
        yield* auth.reload();
        const connected = auth.isConnected("kimi-for-coding", instanceId);
        yield* modelCatalog.refreshInBackground;
        const catalog = yield* modelCatalog.current;

        return {
          instanceId,
          driver: DRIVER_KIND,
          displayName: displayName ?? "Kimi For Coding",
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          enabled: effectiveEnabled,
          installed: true,
          version: null,
          status: !effectiveEnabled ? "disabled" : connected ? "ready" : "warning",
          auth: { status: connected ? "authenticated" : "unauthenticated", type: "oauth" },
          checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
          ...(!connected && effectiveEnabled
            ? { message: "Connect Kimi For Coding in Settings." }
            : {}),
          availability: "available",
          models: ModelCatalog.catalogProviderModels({
            catalog,
            driver: DRIVER_KIND,
            fallbackSlugs: BUILT_IN_MODELS,
            customModels: config.customModels,
          }),
          slashCommands: [],
          // Kimi For Coding has no skill-loading mechanism — its CLI exposes
          // no skill catalog to report (unlike `skills/list`, `grok inspect`,
          // or Claude Code's SKILL.md roots), so the `$` picker correctly
          // stays empty for this provider.
          skills: [],
        } satisfies ServerProvider;
      });

      const refresh = readSnapshot.pipe(
        Effect.tap((snapshot) => PubSub.publish(changes, snapshot)),
      );

      // No periodic health check runs for this driver, so republish when the
      // model catalog changes to bring new models to open clients.
      yield* Stream.runForEach(modelCatalog.changes, () => refresh).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled: effectiveEnabled,
        mastraConnection: {
          environment: processEnv,
          instanceEnvironment: explicitProviderInstanceEnvironment(environment),
          useSavedCredential: instanceUsesSavedCredential("kimi-for-coding", {
            driver: DRIVER_KIND,
            environment,
            config,
          }),
        },
        adapter: undefined,
        textGeneration: undefined,
        snapshot: {
          maintenanceCapabilities: manualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
          getSnapshot: readSnapshot,
          refresh,
          streamChanges: Stream.fromPubSub(changes),
        },
      };
    }),
};
