import {
  KimiSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import type { ProviderDriver } from "../ProviderDriver.ts";
import { defaultProviderContinuationIdentity } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("kimi");
const decodeSettings = Schema.decodeSync(KimiSettings);
const BUILT_IN_MODELS = ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"] as const;

function models(customModels: readonly string[]): ServerProviderModel[] {
  return [...new Set([...BUILT_IN_MODELS, ...customModels.map((model) => model.trim())])]
    .filter((model) => model.length > 0)
    .map((model, index) => ({
      slug: model,
      name: model,
      isCustom: !BUILT_IN_MODELS.includes(model as (typeof BUILT_IN_MODELS)[number]),
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: null,
    }));
}

export type KimiDriverEnv = ServerConfig;

export const KimiDriver: ProviderDriver<KimiSettings, KimiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Kimi For Coding", supportsMultipleInstances: false },
  configSchema: KimiSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const auth = SubscriptionAuthService.forSecretsDir(serverConfig.secretsDir);
      const changes = yield* Effect.acquireRelease(
        PubSub.unbounded<ServerProvider>(),
        PubSub.shutdown,
      );
      const effectiveEnabled = enabled && config.enabled;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const readSnapshot = Effect.sync(() => {
        auth.reload();
        const connected = auth.isConnected("kimi-for-coding");
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
          models: models(config.customModels),
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });
      const refresh = readSnapshot.pipe(
        Effect.tap((snapshot) => PubSub.publish(changes, snapshot)),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled: effectiveEnabled,
        adapter: undefined,
        textGeneration: undefined,
        snapshot: {
          maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
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
