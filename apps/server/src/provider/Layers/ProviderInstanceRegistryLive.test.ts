import { registeredProviderDriver } from "../registeredProviderDriver.ts";
/**
 * Multi-instance validation slices for `ProviderInstanceRegistryLive`.
 *
 * Two axes of the driver/registry refactor are exercised here:
 *
 *  1. **Same driver, many instances** — the "multi-instance codex slice"
 *     describe block below configures two independent `codex` instances and
 *     asserts each gets its own closures and identity. This is the
 *     multi-codex capability the refactor exists to unlock.
 *
 *  2. **Many drivers, one registry** — the "all drivers slice" describe
 *     block below configures one instance of every shipped driver
 *     (`codex`, `claudeAgent`, `grok`, `kimi`, `opencode`) in a single
 *     `ProviderInstanceConfigMap` and asserts the registry boots them all
 *     without cross-contamination. This proves the driver SPI is uniform
 *     across every provider — any driver plugs into the registry through
 *     the same `ProviderDriver` value contract.
 *
 * Every instance in these tests is configured with `enabled: false` so the
 * provider-status checks short-circuit to pending/disabled snapshots
 * without trying to spawn real `codex` / `claude` / `agent` / `grok` / `opencode`
 * binaries. That keeps the assertions focused on registry routing
 * behaviour rather than the runtime details of each provider.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { BuiltInDriversEnv } from "../builtInDrivers.ts";
import { ClaudeDriver } from "../Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../Drivers/CodexDriver.ts";
import { GrokDriver } from "../Drivers/GrokDriver.ts";
import { KimiDriver } from "../Drivers/KimiDriver.ts";
import { OpenCodeDriver } from "../Drivers/OpenCodeDriver.ts";
import { LegacyProviderBridgeLive } from "./LegacyProviderBridge.ts";
import { LegacyProviderBridge } from "../Services/LegacyProviderBridge.ts";
import { ProviderAdapterRegistry, makeProviderAdapterRegistry } from "./ProviderAdapterRegistry.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { providerServiceLayerWith } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";
import {
  makeCodexConfig,
  makeClaudeConfig,
  makeGrokConfig,
  makeKimiConfig,
  makeOpenCodeConfig,
  testLayer,
  allDriversTestLayer,
  kimiTestLayer,
  kimiId,
  kimiThread,
} from "./test-support/providerInstances.ts";

describe("ProviderInstanceRegistryLive — multi-instance codex slice", () => {
  it.live("boots two independent codex instances from a ProviderInstanceConfigMap", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const workId = ProviderInstanceId.make("codex_work");
      const codexDriverKind = ProviderDriverKind.make("codex");

      const configMap: ProviderInstanceConfigMap = {
        [personalId]: {
          driver: codexDriverKind,
          displayName: "Codex (personal)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-personal/bin/codex",
            homePath: "/home/julius/.codex_personal",
            customModels: ["personal-preview"],
          }),
        },
        [workId]: {
          driver: codexDriverKind,
          displayName: "Codex (work)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-work/bin/codex",
            homePath: "/home/julius/.codex",
            customModels: ["work-preview"],
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [registeredProviderDriver(CodexDriver)],
        configMap,
      });

      const instances = yield* registry.listInstances;
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [personalId, workId].toSorted(),
      );
      expect(instances.every((instance) => instance.driverKind === codexDriverKind)).toBe(true);
      expect(instances.map((instance) => instance.displayName).toSorted()).toEqual(
        ["Codex (personal)", "Codex (work)"].toSorted(),
      );

      // Each instance must be retrievable by id and carry its *own* closures.
      const personal = yield* registry.getInstance(personalId);
      const work = yield* registry.getInstance(workId);
      expect(personal).toBeDefined();
      expect(work).toBeDefined();
      expect(personal!.adapter).toBeUndefined();
      expect(work!.adapter).toBeUndefined();
      expect(personal!.mastraConnection).not.toBe(work!.mastraConnection);
      expect(personal!.textGeneration).not.toBe(work!.textGeneration);
      expect(personal!.snapshot).not.toBe(work!.snapshot);

      // Snapshots identify themselves by instanceId + driver — this is
      // what makes per-instance routing distinguishable downstream.
      const personalSnapshot = yield* personal!.snapshot.getSnapshot;
      expect(personalSnapshot.instanceId).toBe(personalId);
      expect(personalSnapshot.driver).toBe(codexDriverKind);
      expect(personalSnapshot.enabled).toBe(false);
      expect(personalSnapshot.continuation?.groupKey).toBe(
        "codex:home:/home/julius/.codex_personal",
      );

      const workSnapshot = yield* work!.snapshot.getSnapshot;
      expect(workSnapshot.instanceId).toBe(workId);
      expect(workSnapshot.driver).toBe(codexDriverKind);
      expect(workSnapshot.enabled).toBe(false);
      expect(workSnapshot.continuation?.groupKey).toBe("codex:home:/home/julius/.codex");

      // Nothing goes to the unavailable bucket — both drivers are registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — multi-instance codex slice", () => {
  it.live("treats an explicit in-config enabled:false as disabling despite the envelope", () =>
    Effect.gen(function* () {
      // Old settings files can carry both flags with conflicting values.
      // The explicit false must win so a user's disable is never undone.
      const staleId = ProviderInstanceId.make("codex_stale");

      const configMap: ProviderInstanceConfigMap = {
        [staleId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: makeCodexConfig({ enabled: false }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [registeredProviderDriver(CodexDriver)],
        configMap,
      });

      const instance = yield* registry.getInstance(staleId);
      expect(instance).toBeDefined();
      expect(instance!.enabled).toBe(false);
      const snapshot = yield* instance!.snapshot.getSnapshot;
      expect(snapshot.enabled).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — multi-instance codex slice", () => {
  it.live("blocks dispatch after disable without awaiting the provider promise", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_atomic");

      const enabledConfig: ProviderInstanceConfigMap = {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: makeCodexConfig({ enabled: true }),
        },
      };

      const disabledConfig: ProviderInstanceConfigMap = {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          config: makeCodexConfig({ enabled: false }),
        },
      };

      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: [registeredProviderDriver(CodexDriver)],
        configMap: enabledConfig,
      });

      let dispatchCalls = 0;
      let resolveDispatch!: () => void;

      const pendingDispatch = new Promise<void>((resolve) => {
        resolveDispatch = resolve;
      });

      const admitted = yield* registry.dispatchIfEnabled(instanceId, () => {
        dispatchCalls += 1;

        return pendingDispatch;
      });

      expect(admitted._tag).toBe("Dispatched");
      expect(dispatchCalls).toBe(1);

      yield* mutator.reconcile(disabledConfig);

      const disabled = yield* registry.dispatchIfEnabled(instanceId, () => {
        dispatchCalls += 1;
      });

      expect(disabled._tag).toBe("Disabled");
      expect(dispatchCalls).toBe(1);

      const missing = yield* registry.dispatchIfEnabled(ProviderInstanceId.make("missing"), () => {
        dispatchCalls += 1;
      });

      expect(missing._tag).toBe("Missing");
      expect(dispatchCalls).toBe(1);
      resolveDispatch();
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — multi-instance codex slice", () => {
  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [registeredProviderDriver(CodexDriver)],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — all drivers slice", () => {
  it.live("boots one instance of every shipped driver from a single config map", () =>
    Effect.gen(function* () {
      const codexId = ProviderInstanceId.make("codex_default");
      const claudeId = ProviderInstanceId.make("claude_default");
      const grokId = ProviderInstanceId.make("grok_default");
      const kimiId = ProviderInstanceId.make("kimi_default");
      const openCodeId = ProviderInstanceId.make("opencode_default");

      const codexDriverKind = ProviderDriverKind.make("codex");
      const claudeDriverKind = ProviderDriverKind.make("claudeAgent");
      const grokDriverKind = ProviderDriverKind.make("grok");
      const kimiDriverKind = ProviderDriverKind.make("kimi");
      const openCodeDriverKind = ProviderDriverKind.make("opencode");

      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: codexDriverKind,
          displayName: "Codex",
          enabled: false,
          config: makeCodexConfig({ homePath: "/home/julius/.codex" }),
        },
        [claudeId]: {
          driver: claudeDriverKind,
          displayName: "Claude",
          enabled: false,
          config: makeClaudeConfig({
            homePath: "/home/julius/.claude-work",
            launchArgs: "--verbose",
          }),
        },
        [grokId]: {
          driver: grokDriverKind,
          displayName: "Grok",
          enabled: false,
          config: makeGrokConfig({}),
        },
        [kimiId]: {
          driver: kimiDriverKind,
          displayName: "Kimi For Coding",
          enabled: false,
          config: makeKimiConfig({}),
        },
        [openCodeId]: {
          driver: openCodeDriverKind,
          displayName: "OpenCode",
          enabled: false,
          config: makeOpenCodeConfig({}),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry<BuiltInDriversEnv>({
        drivers: [
          registeredProviderDriver(CodexDriver),
          registeredProviderDriver(ClaudeDriver),
          registeredProviderDriver(GrokDriver),
          registeredProviderDriver(KimiDriver),
          registeredProviderDriver(OpenCodeDriver),
        ],
        configMap,
      });

      // Every configured instance must materialize — none downgraded to a
      // shadow snapshot, because every driver in the map is registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);

      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(5);
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [codexId, claudeId, grokId, kimiId, openCodeId].toSorted(),
      );

      // Instance lookup by id resolves each instance to its own bundle —
      // this is how rest-of-server routes turn/session calls in the new
      // model. Each driver's bundle carries its advertised `driverKind`.
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      const grok = yield* registry.getInstance(grokId);
      const kimi = yield* registry.getInstance(kimiId);
      const openCode = yield* registry.getInstance(openCodeId);
      expect(codex?.driverKind).toBe(codexDriverKind);
      expect(claude?.driverKind).toBe(claudeDriverKind);
      expect(grok?.driverKind).toBe(grokDriverKind);
      expect(kimi?.driverKind).toBe(kimiDriverKind);
      expect(openCode?.driverKind).toBe(openCodeDriverKind);
      expect(codex?.displayName).toBe("Codex");
      expect(claude?.displayName).toBe("Claude");
      expect(grok?.displayName).toBe("Grok");
      expect(kimi?.displayName).toBe("Kimi For Coding");
      expect(openCode?.displayName).toBe("OpenCode");

      for (const instance of [codex!, claude!, grok!, kimi!]) {
        expect(instance.adapter).toBeUndefined();
        expect(instance.mastraConnection).toBeDefined();
      }

      expect(openCode!.adapter).toBeDefined();

      const textGenerations = [
        codex!.textGeneration,
        claude!.textGeneration,
        grok!.textGeneration,
        openCode!.textGeneration,
      ];

      expect(new Set(textGenerations).size).toBe(textGenerations.length);
      expect(kimi!.adapter).toBeUndefined();
      expect(kimi!.textGeneration).toBeUndefined();

      const snapshots = [
        codex!.snapshot,
        claude!.snapshot,
        grok!.snapshot,
        kimi!.snapshot,
        openCode!.snapshot,
      ];

      expect(new Set(snapshots).size).toBe(snapshots.length);

      // Snapshots identify themselves by `instanceId` + `driver` so
      // downstream aggregation in `ProviderRegistry` can tell instances
      // apart even when two share a driver. With `enabled: false`, the
      // check short-circuits and we get a disabled/pending snapshot back
      // — that's enough signal to validate the stamping wrapper without
      // spawning real binaries.
      const codexSnapshot = yield* codex!.snapshot.getSnapshot;
      expect(codexSnapshot.instanceId).toBe(codexId);
      expect(codexSnapshot.driver).toBe(codexDriverKind);
      expect(codexSnapshot.enabled).toBe(false);
      expect(codexSnapshot.continuation?.groupKey).toBe("codex:home:/home/julius/.codex");

      const claudeSnapshot = yield* claude!.snapshot.getSnapshot;
      expect(claudeSnapshot.instanceId).toBe(claudeId);
      expect(claudeSnapshot.driver).toBe(claudeDriverKind);
      expect(claudeSnapshot.enabled).toBe(false);
      expect(claudeSnapshot.continuation?.groupKey).toBe("claude:home:/home/julius/.claude-work");

      const grokSnapshot = yield* grok!.snapshot.getSnapshot;
      expect(grokSnapshot.instanceId).toBe(grokId);
      expect(grokSnapshot.driver).toBe(grokDriverKind);
      expect(grokSnapshot.enabled).toBe(false);
      expect(grokSnapshot.continuation?.groupKey).toBe(`${grokDriverKind}:instance:${grokId}`);

      const kimiSnapshot = yield* kimi!.snapshot.getSnapshot;
      expect(kimiSnapshot.instanceId).toBe(kimiId);
      expect(kimiSnapshot.driver).toBe(kimiDriverKind);
      expect(kimiSnapshot.enabled).toBe(false);
      expect(kimiSnapshot.continuation?.groupKey).toBe(`${kimiDriverKind}:instance:${kimiId}`);

      const openCodeSnapshot = yield* openCode!.snapshot.getSnapshot;
      expect(openCodeSnapshot.instanceId).toBe(openCodeId);
      expect(openCodeSnapshot.driver).toBe(openCodeDriverKind);
      expect(openCodeSnapshot.enabled).toBe(false);
      expect(openCodeSnapshot.continuation?.groupKey).toBe(
        `${openCodeDriverKind}:instance:${openCodeId}`,
      );
    }).pipe(Effect.provide(allDriversTestLayer)),
  );
});

describe("ProviderInstanceRegistryLive — Kimi never reaches the legacy bridge", () => {
  it.live("fails closed through ProviderService and LegacyProviderBridge", () =>
    Effect.gen(function* () {
      const configMap: ProviderInstanceConfigMap = {
        [kimiId]: {
          driver: ProviderDriverKind.make("kimi"),
          displayName: "Kimi For Coding",
          enabled: true,
          config: makeKimiConfig({ enabled: true }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [registeredProviderDriver(KimiDriver)],
        configMap,
      });

      // The instance itself carries no legacy transport closures.
      const kimi = yield* registry.getInstance(kimiId);
      expect(kimi).toBeDefined();
      expect(kimi!.adapter).toBeUndefined();
      expect(kimi!.textGeneration).toBeUndefined();
      expect(kimi!.mastraConnection).toBeDefined();

      // The real adapter-registry facade fails closed for the Kimi
      // instance while non-adapter routing metadata still resolves —
      // `AgentController` depends on that metadata for Mastra drivers.
      const adapterRegistry = yield* Effect.provideService(
        makeProviderAdapterRegistry(),
        ProviderInstanceRegistry,
        registry,
      );

      const lookup = yield* adapterRegistry.getByInstance(kimiId).pipe(Effect.flip);
      expect(lookup._tag).toBe("ProviderUnsupportedError");
      const info = yield* adapterRegistry.getInstanceInfo(kimiId);
      expect(info.driverKind).toBe("kimi");
      expect(info.enabled).toBe(true);
      expect(info.mastraConnection).toBeDefined();

      // Materialize the real ProviderService + LegacyProviderBridge on
      // top of this registry and push the full legacy surface through it.
      // Build the layer inside the test scope so the in-memory database
      // backing the session directory stays open for the whole test.
      const bridgeContext = yield* Layer.build(
        LegacyProviderBridgeLive.pipe(
          Layer.provide(
            providerServiceLayerWith().pipe(
              Layer.provide(Layer.succeed(ProviderAdapterRegistry, adapterRegistry)),
              Layer.provide(
                ProviderSessionDirectoryLive.pipe(
                  Layer.provide(
                    ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory)),
                  ),
                ),
              ),
            ),
          ),
        ),
      );

      const bridge = Context.get(bridgeContext, LegacyProviderBridge);

      const startError = yield* bridge
        .startSession(kimiThread, {
          threadId: kimiThread,
          provider: ProviderDriverKind.make("kimi"),
          providerInstanceId: kimiId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      expect(startError._tag).toBe("ProviderUnsupportedError");

      // The directory never saw a binding, so sendTurn fails closed at
      // routing — before any adapter resolution could produce a turn.
      const sendError = yield* bridge
        .sendTurn({ threadId: kimiThread, input: "This must never reach a provider." })
        .pipe(Effect.flip);

      expect(sendError._tag).toBe("ProviderValidationError");

      const interruptError = yield* bridge
        .interruptTurn({ threadId: kimiThread })
        .pipe(Effect.flip);

      expect(interruptError._tag).toBe("ProviderValidationError");

      const sessions = yield* bridge.listSessions();
      expect(sessions).toEqual([]);
    }).pipe(Effect.provide(kimiTestLayer)),
  );
});
