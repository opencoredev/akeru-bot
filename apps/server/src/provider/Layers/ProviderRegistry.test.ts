import * as Deferred from "effect/Deferred";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@akeru/contracts";
import { createModelCapabilities } from "@akeru/shared/model";
import {
  haveProvidersChanged,
  mergeProviderSnapshot,
  ProviderRegistryLive,
} from "./ProviderRegistry.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import { readProviderStatusCache, resolveProviderStatusCachePath } from "../providerStatusCache.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  TestHttpClientLive,
  BackgroundPolicyAlwaysRunLayer,
  selectDescriptor,
  booleanDescriptor,
} from "./test-support/providerProbe.ts";

process.env.T3CODE_CURSOR_ENABLED = "1";

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it("treats equal provider snapshots as unchanged", () => {
        const providers = [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
          {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            status: "warning",
            enabled: true,
            installed: true,
            auth: { status: "unknown" },
            checkedAt: "2026-03-25T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          },
        ] as const satisfies ReadonlyArray<ServerProvider>;

        assert.strictEqual(haveProvidersChanged(providers, [...providers]), false);
      });
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it("ignores checkedAt when deciding whether providers changed", () => {
        const provider = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: ProviderDriverKind.make("claudeAgent"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-03-25T00:00:00.000Z",
          version: "1.0.0",
          models: [],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;

        const rechecked = { ...provider, checkedAt: "2026-03-25T00:05:00.000Z" };

        assert.strictEqual(haveProvidersChanged([provider], [rechecked]), false);
        assert.strictEqual(
          haveProvidersChanged([provider], [{ ...rechecked, status: "warning" }]),
          true,
        );
      });
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it("preserves previously discovered provider models when a refresh returns none", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                  booleanDescriptor("fastMode", "Fast Mode"),
                  booleanDescriptor("thinking", "Thinking"),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;

        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it("drops stale OpenCode models missing from a successful refresh", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "removed-plugin/model",
              name: "Removed Plugin Model",
              subProvider: "Removed Plugin",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;

        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-07-17T00:01:00.000Z",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...refreshedProvider.models,
        ]);
      });
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it("retains stale OpenCode models when a refresh fails", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;

        const refreshedProvider = {
          ...previousProvider,
          status: "error",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:01:00.000Z",
          models: [],
          message: "Failed to refresh OpenCode models.",
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it("drops Grok models only after a complete probe", () => {
        const model = (slug: string) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        });

        const previousProvider = {
          instanceId: ProviderInstanceId.make("grok"),
          driver: ProviderDriverKind.make("grok"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          models: [model("grok-build"), model("stale-alias")],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;

        const cleanProbe = {
          ...previousProvider,
          checkedAt: "2026-07-17T00:01:00.000Z",
          models: [model("grok-build")],
        } satisfies ServerProvider;

        const failedProbe = {
          ...previousProvider,
          status: "error",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:01:00.000Z",
          models: [model("grok-build")],
          message: "Failed to execute Grok CLI health check.",
        } satisfies ServerProvider;

        const partialProbe = {
          ...cleanProbe,
          status: "warning",
          message: "Grok ACP initialize failed. Model options may be incomplete.",
        } satisfies ServerProvider;

        const signedOut = {
          ...failedProbe,
          auth: { status: "unauthenticated" },
          message: "Grok CLI is installed but not logged in. Run `grok login`.",
        } satisfies ServerProvider;

        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, cleanProbe).models.map((entry) => entry.slug),
          ["grok-build"],
        );
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, failedProbe).models.map((entry) => entry.slug),
          ["grok-build", "stale-alias"],
        );
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, partialProbe).models.map((entry) => entry.slug),
          ["grok-build", "stale-alias"],
        );
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, signedOut).models.map((entry) => entry.slug),
          ["grok-build", "stale-alias"],
        );
      });
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it("classifies pending, logout, uninstall, and reconnect OpenCode inventories", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-07-17T00:00:00.000Z",
          version: "1.0.0",
          models: [
            {
              slug: "github/gpt-5",
              name: "GPT-5",
              subProvider: "GitHub",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "removed-plugin/model",
              name: "Removed Plugin Model",
              subProvider: "Removed Plugin",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;

        const pendingProvider = {
          ...previousProvider,
          status: "warning",
          installed: false,
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:01:00.000Z",
          version: null,
          models: [],
          message: "OpenCode provider status has not been checked in this session yet.",
        } satisfies ServerProvider;

        const loggedOutProvider = {
          ...previousProvider,
          status: "warning",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:02:00.000Z",
          models: [],
          message: "OpenCode is available, but it did not report any connected upstream providers.",
        } satisfies ServerProvider;

        const missingProvider = {
          ...previousProvider,
          status: "error",
          installed: false,
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:03:00.000Z",
          version: null,
          models: [],
          message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
        } satisfies ServerProvider;

        const authoritativeProvider = {
          ...previousProvider,
          checkedAt: "2026-07-17T00:04:00.000Z",
          models: [previousProvider.models[0]!],
        } satisfies ServerProvider;

        const failedProvider = {
          ...authoritativeProvider,
          status: "error",
          auth: { status: "unknown" },
          checkedAt: "2026-07-17T00:05:00.000Z",
          models: [],
          message: "Failed to refresh OpenCode models.",
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, pendingProvider).models, [
          ...previousProvider.models,
        ]);
        assert.deepStrictEqual(
          mergeProviderSnapshot(previousProvider, loggedOutProvider).models,
          [],
        );
        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, missingProvider).models, []);

        const afterRemoval = mergeProviderSnapshot(previousProvider, authoritativeProvider);
        const afterFailure = mergeProviderSnapshot(afterRemoval, failedProvider);

        assert.deepStrictEqual(afterFailure.models, [authoritativeProvider.models[0]!]);
      });
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it("fills missing capabilities from the previous provider snapshot", () => {
        const previousProvider = {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          status: "ready",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          checkedAt: "2026-04-14T00:00:00.000Z",
          version: "2026.04.09-f2b0fcd",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [
                  selectDescriptor("reasoning", "Reasoning", [
                    { id: "high", label: "High", isDefault: true },
                  ]),
                  booleanDescriptor("fastMode", "Fast Mode"),
                  booleanDescriptor("thinking", "Thinking"),
                ],
              }),
            },
          ],
          slashCommands: [],
          skills: [],
        } as const satisfies ServerProvider;

        const refreshedProvider = {
          ...previousProvider,
          checkedAt: "2026-04-14T00:01:00.000Z",
          models: [
            {
              slug: "claude-opus-4-6",
              name: "Opus 4.6",
              isCustom: false,
              capabilities: createModelCapabilities({
                optionDescriptors: [],
              }),
            },
          ],
        } satisfies ServerProvider;

        assert.deepStrictEqual(mergeProviderSnapshot(previousProvider, refreshedProvider).models, [
          ...previousProvider.models,
        ]);
      });
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it.effect("does not run provider probes during layer construction", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");

          const initialProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "warning",
            enabled: true,
            installed: false,
            auth: { status: "unknown" },
            checkedAt: "2026-06-10T00:00:00.000Z",
            version: null,
            message: "Checking Codex provider status.",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;

          const refreshCalls = yield* Ref.make(0);

          const instance = {
            instanceId: codexInstanceId,
            driverKind: codexDriver,
            continuationIdentity: {
              driverKind: codexDriver,
              continuationKey: "codex:instance:codex",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: codexDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Ref.update(refreshCalls, (count) => count + 1).pipe(
                Effect.andThen(Effect.never),
              ),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;

          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === codexInstanceId ? instance : undefined),
              dispatchIfEnabled: (instanceId, dispatch) =>
                Effect.sync(() =>
                  instanceId === codexInstanceId
                    ? ({ _tag: "Dispatched", value: dispatch() } as const)
                    : ({ _tag: "Missing" } as const),
                ),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
            },
          );

          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-background-refresh-",
                }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            assert.deepStrictEqual(yield* registry.getProviders, [initialProvider]);
            assert.strictEqual(yield* Ref.get(refreshCalls), 0);
          }).pipe(Effect.provide(runtimeServices));
        }),
      );
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it.effect("persists the merged snapshot when a live update has empty models", () =>
        Effect.gen(function* () {
          const cursorDriver = ProviderDriverKind.make("cursor");
          const cursorInstanceId = ProviderInstanceId.make("cursor");

          const initialProvider = {
            instanceId: cursorInstanceId,
            driver: cursorDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "2026.04.09-f2b0fcd",
            models: [
              {
                slug: "claude-opus-4-6",
                name: "Opus 4.6",
                isCustom: false,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    selectDescriptor("reasoning", "Reasoning", [
                      { id: "high", label: "High", isDefault: true },
                    ]),
                  ],
                }),
              },
            ],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;

          const refreshedProvider = {
            ...initialProvider,
            checkedAt: "2026-04-14T00:01:00.000Z",
            models: [],
          } satisfies ServerProvider;

          const changes = yield* PubSub.unbounded<ServerProvider>();

          const instance = {
            instanceId: cursorInstanceId,
            driverKind: cursorDriver,
            continuationIdentity: {
              driverKind: cursorDriver,
              continuationKey: "cursor:instance:cursor",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: cursorDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Effect.succeed(refreshedProvider),
              streamChanges: Stream.fromPubSub(changes),
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;

          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === cursorInstanceId ? instance : undefined),
              dispatchIfEnabled: (instanceId, dispatch) =>
                Effect.sync(() =>
                  instanceId === cursorInstanceId
                    ? ({ _tag: "Dispatched", value: dispatch() } as const)
                    : ({ _tag: "Missing" } as const),
                ),
              listInstances: Effect.succeed([instance]),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
                PubSub.subscribe(pubsub),
              ),
            },
          );

          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-merged-persist-",
                }),
              ),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const config = yield* ServerConfig.ServerConfig;

            const filePath = yield* resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              instanceId: cursorInstanceId,
            });

            assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
              ...initialProvider.models,
            ]);
            const persisted = yield* Deferred.make<void>();
            yield* registry.streamChanges.pipe(
              Stream.filter((providers) =>
                providers.some((provider) => provider.checkedAt === refreshedProvider.checkedAt),
              ),
              Stream.take(1),
              Stream.runForEach(() => Deferred.succeed(persisted, undefined)),
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* PubSub.publish(changes, refreshedProvider);
            yield* Deferred.await(persisted);
            const cachedProvider = yield* readProviderStatusCache(filePath);

            assert.deepStrictEqual(cachedProvider, {
              ...refreshedProvider,
              models: [...initialProvider.models],
            });
          }).pipe(Effect.provide(runtimeServices));
        }),
      );
    });
  },
);
