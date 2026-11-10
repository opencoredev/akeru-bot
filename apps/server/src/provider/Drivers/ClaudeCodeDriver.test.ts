import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { ClaudeCodeDriver, claudeCodeContinuationKey } from "./ClaudeCodeDriver.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
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

const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "akeru-claude-code-driver-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
  serverSettingsLayerTest(),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
    ),
  ),
  Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  BackgroundPolicyAlwaysRunLayer,
);

// A program that does not exist, and disabled instances, so no real Claude Code runs.
const config = Schema.decodeSync(ClaudeSettings)({ binaryPath: "/no/provider/claude" });

const create = (
  instanceId: string,
  environment: Parameters<typeof ClaudeCodeDriver.create>[0]["environment"] = [],
) =>
  ClaudeCodeDriver.create({
    instanceId: ProviderInstanceId.make(instanceId),
    displayName: undefined,
    accentColor: undefined,
    environment,
    enabled: false,
    config,
  }).pipe(Effect.flatMap((instance) => instance.snapshot.getSnapshot));

describe("ClaudeCodeDriver", () => {
  it.effect("gives a separate account its own config folder and publishes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig;
        const original = yield* create("claudeCode");
        const work = yield* create("claudeCode_work");
        const assigned = NodePath.join(stateDir, "providers", "claude-code", "claudeCode_work");

        expect(original.configDirectory).toBeUndefined();
        expect(work.configDirectory).toBe(assigned);
        expect(NodeFS.statSync(assigned).isDirectory()).toBe(true);
        expect(work.continuation?.groupKey).toBe(claudeCodeContinuationKey(assigned));
        expect(work.continuation?.groupKey).not.toBe(original.continuation?.groupKey);
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a folder from a sensitive variable on the server", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig;
        const hidden = NodePath.join(stateDir, "hidden-claude");

        const snapshot = yield* create("claudeCode_secret", [
          { name: "CLAUDE_CONFIG_DIR", value: hidden, sensitive: true },
        ]);

        expect(snapshot.configDirectory).toBeUndefined();
        expect(snapshot.continuation?.groupKey).toBe(claudeCodeContinuationKey(hidden));
        // Remote clients see the snapshot, so no field may carry the hidden folder.
        expect(JSON.stringify(snapshot)).not.toContain(hidden);
        expect(NodeFS.existsSync(NodePath.join(stateDir, "providers", "claude-code"))).toBe(false);
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
