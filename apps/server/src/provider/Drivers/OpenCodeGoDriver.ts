import {
  OpenCodeGoSettings,
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

const DRIVER_KIND = ProviderDriverKind.make("opencodeGo");
const decodeSettings = Schema.decodeSync(OpenCodeGoSettings);

export const OPEN_CODE_GO_MODELS = [
  "gpt-5.6-luna",
  "grok-4.5",
  "grok-4.6",
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "kimi-k3",
  "kimi-k2.7-code",
  "kimi-k2.6",
  "kimi-k2.5",
  "longcat-2.0",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "minimax-m3",
  "minimax-m2.7",
  "minimax-m2.5",
  "muse-spark-1.2-contributor",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
  "qwen3.5-plus",
  "hy4-preview",
  "hy3",
  "hy3-preview",
] as const;

function models(customModels: readonly string[]): ServerProviderModel[] {
  const modelIds = [...OPEN_CODE_GO_MODELS, ...customModels.map((model) => model.trim())];
  return [...new Set(modelIds)]
    .filter((model) => model.length > 0)
    .map((model, index) => ({
      slug: model,
      name: model,
      isCustom: !OPEN_CODE_GO_MODELS.includes(model as (typeof OPEN_CODE_GO_MODELS)[number]),
      ...(index === 0 ? { isDefault: true } : {}),
      capabilities: null,
    }));
}

export type OpenCodeGoDriverEnv = ServerConfig;

export const OpenCodeGoDriver: ProviderDriver<OpenCodeGoSettings, OpenCodeGoDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "OpenCode Go", supportsMultipleInstances: false },
  configSchema: OpenCodeGoSettings,
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
        const connected = auth.isConnected("opencode-go");
        return {
          instanceId,
          driver: DRIVER_KIND,
          displayName: displayName ?? "OpenCode Go",
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          enabled: effectiveEnabled,
          installed: true,
          version: null,
          status: !effectiveEnabled ? "disabled" : connected ? "ready" : "warning",
          auth: { status: connected ? "authenticated" : "unauthenticated", type: "apiKey" },
          checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
          ...(!connected && effectiveEnabled
            ? { message: "Connect OpenCode Go in Settings." }
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
