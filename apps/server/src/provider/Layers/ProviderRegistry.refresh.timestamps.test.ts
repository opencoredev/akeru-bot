import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@akeru/contracts";
import { ProviderRegistryLive } from "./ProviderRegistry.ts";
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
} from "./test-support/providerProbe.ts";

process.env.T3CODE_CURSOR_ENABLED = "1";

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it.effect("publishes a completed probe that only moved checkedAt", () =>
        Effect.gen(function* () {
          const claudeDriver = ProviderDriverKind.make("claudeAgent");
          const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

          const initialProvider = {
            instanceId: claudeInstanceId,
            driver: claudeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-14T00:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;

          const reprobedProvider = {
            ...initialProvider,
            checkedAt: "2026-04-14T00:05:00.000Z",
          } satisfies ServerProvider;

          const changes = yield* PubSub.unbounded<ServerProvider>();

          const instance = {
            instanceId: claudeInstanceId,
            driverKind: claudeDriver,
            continuationIdentity: {
              driverKind: claudeDriver,
              continuationKey: "claudeAgent:instance:claudeAgent",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: claudeDriver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(initialProvider),
              refresh: Effect.succeed(reprobedProvider),
              streamChanges: Stream.fromPubSub(changes),
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          } satisfies ProviderInstance;

          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Effect.succeed(instanceId === claudeInstanceId ? instance : undefined),
              dispatchIfEnabled: (instanceId, dispatch) =>
                Effect.sync(() =>
                  instanceId === claudeInstanceId
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
                  prefix: "t3-provider-registry-checked-at-publish-",
                }),
              ),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;

            const published = yield* registry.streamChanges.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped({ startImmediately: true }),
            );

            // The status change is always published, so the first broadcast
            // shows whether the checkedAt-only probe went out before it.
            yield* PubSub.publish(changes, reprobedProvider);
            yield* PubSub.publish(changes, {
              ...reprobedProvider,
              checkedAt: "2026-04-14T00:10:00.000Z",
              status: "warning",
            });

            const [providers] = yield* Fiber.join(published);
            assert.strictEqual(providers?.[0]?.checkedAt, reprobedProvider.checkedAt);
            assert.strictEqual(providers?.[0]?.status, "ready");
          }).pipe(Effect.provide(runtimeServices), Effect.scoped);
        }),
      );
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it.effect(
        "persists authoritative OpenCode removals without resurrecting them on a failed live refresh",
        () =>
          Effect.gen(function* () {
            const openCodeDriver = ProviderDriverKind.make("opencode");
            const openCodeInstanceId = ProviderInstanceId.make("opencode");

            const initialProvider = {
              instanceId: openCodeInstanceId,
              driver: openCodeDriver,
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

            const authoritativeProvider = {
              ...initialProvider,
              checkedAt: "2026-07-17T00:01:00.000Z",
              models: [initialProvider.models[0]!],
            } satisfies ServerProvider;

            const failedProvider = {
              ...authoritativeProvider,
              status: "error",
              auth: { status: "unknown" },
              checkedAt: "2026-07-17T00:02:00.000Z",
              models: [],
              message: "Failed to refresh OpenCode models.",
            } satisfies ServerProvider;

            const changes = yield* PubSub.unbounded<ServerProvider>();

            const instance = {
              instanceId: openCodeInstanceId,
              driverKind: openCodeDriver,
              continuationIdentity: {
                driverKind: openCodeDriver,
                continuationKey: "opencode:instance:opencode",
              },
              displayName: undefined,
              enabled: true,
              snapshot: {
                maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                  provider: openCodeDriver,
                  packageName: null,
                }),
                getSnapshot: Effect.succeed(initialProvider),
                refresh: Effect.succeed(authoritativeProvider),
                streamChanges: Stream.fromPubSub(changes),
              },
              adapter: {} as ProviderInstance["adapter"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            } satisfies ProviderInstance;

            const instanceRegistryLayer = Layer.succeed(
              ProviderInstanceRegistry.ProviderInstanceRegistry,
              {
                getInstance: (instanceId) =>
                  Effect.succeed(instanceId === openCodeInstanceId ? instance : undefined),
                dispatchIfEnabled: (instanceId, dispatch) =>
                  Effect.sync(() =>
                    instanceId === openCodeInstanceId
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
                    prefix: "t3-provider-registry-opencode-authoritative-persist-",
                  }),
                ),
                Layer.provideMerge(NodeServices.layer),
              ),
            ).pipe(Scope.provide(scope));

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              const config = yield* ServerConfig.ServerConfig;

              const filePath = yield* resolveProviderStatusCachePath({
                cacheDir: config.providerStatusCacheDir,
                instanceId: openCodeInstanceId,
              });

              yield* PubSub.publish(changes, authoritativeProvider);

              let cachedProvider = yield* readProviderStatusCache(filePath);

              for (
                let attempt = 0;
                attempt < 50 && cachedProvider?.checkedAt !== authoritativeProvider.checkedAt;
                attempt += 1
              ) {
                yield* TestClock.adjust("10 millis");
                yield* Effect.yieldNow;
                cachedProvider = yield* readProviderStatusCache(filePath);
              }

              assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);

              yield* PubSub.publish(changes, failedProvider);

              for (
                let attempt = 0;
                attempt < 50 && cachedProvider?.checkedAt !== failedProvider.checkedAt;
                attempt += 1
              ) {
                yield* TestClock.adjust("10 millis");
                yield* Effect.yieldNow;
                cachedProvider = yield* readProviderStatusCache(filePath);
              }

              assert.deepStrictEqual(cachedProvider?.models, [authoritativeProvider.models[0]!]);
              assert.deepStrictEqual((yield* registry.getProviders)[0]?.models, [
                authoritativeProvider.models[0]!,
              ]);
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
      it.effect("returns the cached provider list when a manual refresh fails", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");

          const cachedProvider = {
            instanceId: codexInstanceId,
            driver: codexDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:00:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;

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
              getSnapshot: Effect.succeed(cachedProvider),
              refresh: Effect.die(new Error("simulated refresh failure")),
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
                  prefix: "t3-provider-registry-refresh-failure-",
                }),
              ),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;

            assert.deepStrictEqual(yield* registry.getProviders, [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refresh(codexDriver), [cachedProvider]);
            assert.deepStrictEqual(yield* registry.refreshInstance(codexInstanceId), [
              cachedProvider,
            ]);
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
      it.effect("keeps the newest provider result across refreshes and the change stream", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          yield* TestClock.setTime(Date.parse("2026-04-29T11:00:00.000Z"));

          const makeProvider = (checkedAt: string, version: string): ServerProvider =>
            ({
              instanceId: codexInstanceId,
              driver: codexDriver,
              status: "ready",
              enabled: true,
              installed: true,
              auth: { status: "authenticated" },
              checkedAt,
              version,
              models: [],
              slashCommands: [],
              skills: [],
            }) as const satisfies ServerProvider;

          const cachedProvider = makeProvider("2026-04-29T10:00:00.000Z", "1.0.0");
          const olderProvider = makeProvider("2026-04-29T10:01:00.000Z", "1.0.1");
          const newerProvider = makeProvider("2026-04-29T10:02:00.000Z", "1.0.2");

          const probes = [
            {
              started: yield* Deferred.make<void>(),
              release: yield* Deferred.make<void>(),
              result: olderProvider,
            },
            {
              started: yield* Deferred.make<void>(),
              release: yield* Deferred.make<void>(),
              result: newerProvider,
            },
          ] as const;

          const probeCount = yield* Ref.make(0);
          const changes = yield* PubSub.unbounded<ServerProvider>();

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
              getSnapshot: Effect.succeed(cachedProvider),
              refresh: Effect.gen(function* () {
                const probe = probes[yield* Ref.getAndUpdate(probeCount, (count) => count + 1)]!;
                yield* Deferred.succeed(probe.started, undefined);
                yield* Deferred.await(probe.release);

                return probe.result;
              }),
              streamChanges: Stream.fromPubSub(changes),
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
                  prefix: "t3-provider-registry-probe-order-",
                }),
              ),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;

            // The background probe starts first, then the explicit refresh.
            const olderProbe = yield* registry
              .refreshInstance(codexInstanceId)
              .pipe(Effect.forkScoped);

            yield* Deferred.await(probes[0].started);

            const newerProbe = yield* registry
              .refreshInstance(codexInstanceId)
              .pipe(Effect.forkScoped);

            yield* Deferred.await(probes[1].started);

            yield* Deferred.succeed(probes[1].release, undefined);
            assert.deepStrictEqual(yield* Fiber.join(newerProbe), [newerProvider]);

            yield* Deferred.succeed(probes[0].release, undefined);
            assert.deepStrictEqual(yield* Fiber.join(olderProbe), [newerProvider]);
            assert.deepStrictEqual(yield* registry.getProviders, [newerProvider]);

            // A stale result delivered late on the change stream is dropped,
            // while a newer status change still lands. Stream items apply in
            // order, so the first broadcast shows whether the stale one landed.
            const signedOutProvider: ServerProvider = {
              ...newerProvider,
              checkedAt: "2026-04-29T10:03:00.000Z",
              status: "warning",
              auth: { status: "unauthenticated" },
            };

            const afterSignOut = yield* registry.streamChanges.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped({ startImmediately: true }),
            );

            yield* PubSub.publish(changes, olderProvider);
            yield* PubSub.publish(changes, signedOutProvider);
            assert.deepStrictEqual(yield* Fiber.join(afterSignOut), [[signedOutProvider]]);

            // If the clock moved back, a stored result from the "future" does
            // not block new results.
            yield* TestClock.setTime(Date.parse("2026-04-29T09:00:00.000Z"));

            const afterClockReset = yield* registry.streamChanges.pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped({ startImmediately: true }),
            );

            yield* PubSub.publish(changes, olderProvider);
            assert.deepStrictEqual(yield* Fiber.join(afterClockReset), [[olderProvider]]);
          }).pipe(Effect.provide(runtimeServices), Effect.scoped);
        }),
      );
    });
  },
);
