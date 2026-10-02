import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ClaudeSettings,
  type CodexSettings,
  type GrokSettings,
  type KimiSettings,
  type OpenCodeSettings,
  ProviderInstanceId,
  ThreadId,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as BackgroundPolicy from "../../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as ModelManifest from "../../ModelManifest.ts";
import { OpenCodeRuntimeLive } from "../../opencodeRuntime.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../ProviderEventLoggers.ts";

export const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

export const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

export const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

export const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

export const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  autoCompactWindow: "",
  ...overrides,
});

export const makeGrokConfig = (overrides: Partial<GrokSettings>): GrokSettings => ({
  enabled: false,
  binaryPath: "grok",
  customModels: [],
  verboseProtocolLogging: false,
  ...overrides,
});

export const makeKimiConfig = (overrides: Partial<KimiSettings>): KimiSettings => ({
  enabled: false,
  customModels: [],
  ...overrides,
});

export const makeOpenCodeConfig = (overrides: Partial<OpenCodeSettings>): OpenCodeSettings => ({
  enabled: false,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  customModels: [],
  ...overrides,
});

export const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "provider-instance-registry-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(TestHttpClientLive),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(ModelManifest.layerTest),
);

export const infraLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

export const allDriversTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "provider-instance-registry-all-drivers-test",
}).pipe(
  Layer.provideMerge(infraLayer),
  Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(TestHttpClientLive),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(ModelManifest.layerTest),
);

export const kimiId = ProviderInstanceId.make("kimi_default");

export const kimiThread = ThreadId.make("thread-registry-kimi");

export const kimiTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "provider-instance-registry-kimi-no-bridge-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(TestHttpClientLive),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(ModelManifest.layerTest),
);
