import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings as ContractServerSettings,
} from "@akeru/contracts";
import { deepMerge } from "@akeru/shared/Struct";
import * as ModelManifest from "../ModelManifest.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderInstanceRegistryHydrationLive } from "./ProviderInstanceRegistryHydration.ts";
import { ProviderRegistryLive } from "./ProviderRegistry.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  decodeServerSettings,
  encodedDefaultServerSettings,
  TestHttpClientLive,
  BackgroundPolicyAlwaysRunLayer,
  mockCommandSpawnerLayer,
  makeMutableServerSettingsService,
} from "./test-support/providerProbe.ts";

process.env.T3CODE_CURSOR_ENABLED = "1";

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("ProviderRegistryLive", () => {
      it.effect("keeps consuming registry changes after one sync fails", () =>
        Effect.gen(function* () {
          const codexDriver = ProviderDriverKind.make("codex");
          const codexInstanceId = ProviderInstanceId.make("codex");
          const claudeDriver = ProviderDriverKind.make("claudeAgent");
          const claudeInstanceId = ProviderInstanceId.make("claudeAgent");

          const codexProvider = {
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

          const claudeProvider = {
            instanceId: claudeInstanceId,
            driver: claudeDriver,
            status: "ready",
            enabled: true,
            installed: true,
            auth: { status: "authenticated" },
            checkedAt: "2026-04-29T10:01:00.000Z",
            version: "1.0.0",
            models: [],
            slashCommands: [],
            skills: [],
          } as const satisfies ServerProvider;

          const makeInstance = (provider: ServerProvider): ProviderInstance => ({
            instanceId: provider.instanceId,
            driverKind: provider.driver,
            continuationIdentity: {
              driverKind: provider.driver,
              continuationKey: `${provider.driver}:instance:${provider.instanceId}`,
            },
            displayName: undefined,
            enabled: true,
            snapshot: {
              maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
                provider: provider.driver,
                packageName: null,
              }),
              getSnapshot: Effect.succeed(provider),
              refresh: Effect.succeed(provider),
              streamChanges: Stream.empty,
            },
            adapter: {} as ProviderInstance["adapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          });

          const codexInstance = makeInstance(codexProvider);
          const claudeInstance = makeInstance(claudeProvider);
          const changes = yield* PubSub.unbounded<void>();
          const instancesRef = yield* Ref.make<ReadonlyArray<ProviderInstance>>([codexInstance]);
          const failNextList = yield* Ref.make(false);
          const wait = () => Effect.yieldNow;

          const instanceRegistryLayer = Layer.succeed(
            ProviderInstanceRegistry.ProviderInstanceRegistry,
            {
              getInstance: (instanceId) =>
                Ref.get(instancesRef).pipe(
                  Effect.map((instances) =>
                    instances.find((instance) => instance.instanceId === instanceId),
                  ),
                ),
              dispatchIfEnabled: (instanceId, dispatch) =>
                Ref.get(instancesRef).pipe(
                  Effect.map((instances) =>
                    instances.some((instance) => instance.instanceId === instanceId)
                      ? ({ _tag: "Dispatched", value: dispatch() } as const)
                      : ({ _tag: "Missing" } as const),
                  ),
                ),
              listInstances: Effect.gen(function* () {
                const shouldFail = yield* Ref.get(failNextList);

                if (shouldFail) {
                  yield* Ref.set(failNextList, false);

                  return yield* Effect.die(new Error("simulated registry list failure"));
                }

                return yield* Ref.get(instancesRef);
              }),
              listUnavailable: Effect.succeed([]),
              streamChanges: Stream.fromPubSub(changes),
              subscribeChanges: PubSub.subscribe(changes),
            },
          );

          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

          const runtimeServices = yield* Layer.build(
            ProviderRegistryLive.pipe(
              Layer.provideMerge(instanceRegistryLayer),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-sync-failure-",
                }),
              ),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ).pipe(Scope.provide(scope));

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            assert.deepStrictEqual(yield* registry.getProviders, [codexProvider]);

            yield* Ref.set(failNextList, true);
            yield* PubSub.publish(changes, undefined);

            yield* Ref.set(instancesRef, [codexInstance, claudeInstance]);
            yield* PubSub.publish(changes, undefined);

            let providers = yield* registry.getProviders;

            for (
              let attempt = 0;
              attempt < 50 &&
              !providers.some((provider) => provider.instanceId === claudeInstanceId);
              attempt += 1
            ) {
              yield* wait();
              providers = yield* registry.getProviders;
            }

            assert.deepStrictEqual(
              providers.map((provider) => provider.instanceId).toSorted(),
              [codexInstanceId, claudeInstanceId].toSorted(),
            );
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
      it.effect("includes unavailable instance snapshots in getProviders", () =>
        Effect.gen(function* () {
          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  codex: { enabled: false },
                  claudeAgent: { enabled: false },
                  grok: { enabled: false },
                  opencode: { enabled: false },
                },
                providerInstances: {
                  ghost_main: {
                    driver: "ghostDriver",
                    displayName: "A fork-only driver we don't ship",
                    enabled: false,
                    config: { arbitrary: "payload" },
                  },
                } as ContractServerSettings["providerInstances"],
              }),
            ),
          );

          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

          const providerRegistryLayer = ProviderRegistryLive.pipe(
            Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
            Layer.provideMerge(
              Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "t3-provider-registry-",
              }),
            ),
            Layer.provideMerge(TestHttpClientLive),
            Layer.provideMerge(
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
            Layer.provideMerge(ModelManifest.layerTest),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
          );

          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            const providers = yield* registry.getProviders;
            const ghost = providers.find((provider) => provider.instanceId === "ghost_main");

            assert.notStrictEqual(ghost, undefined);
            assert.strictEqual(ghost?.driver, "ghostDriver");
            assert.strictEqual(ghost?.availability, "unavailable");
            assert.match(ghost?.unavailableReason ?? "", /ghostDriver/);
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
      it.effect(
        "does not register Cursor and skips its probe when settings use their defaults",
        () =>
          Effect.gen(function* () {
            const serverSettings = yield* makeMutableServerSettingsService(
              decodeServerSettings(
                deepMerge(encodedDefaultServerSettings, {
                  providers: {
                    codex: {
                      enabled: false,
                    },
                    grok: {
                      enabled: false,
                    },
                  },
                }),
              ),
            );

            let cursorSpawned = false;
            const scope = yield* Scope.make();
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

            const providerRegistryLayer = ProviderRegistryLive.pipe(
              Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
              Layer.provideMerge(
                Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
              ),
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-provider-registry-",
                }),
              ),
              Layer.provideMerge(TestHttpClientLive),
              Layer.provideMerge(
                Layer.succeed(
                  ProviderEventLoggers.ProviderEventLoggers,
                  ProviderEventLoggers.NoOpProviderEventLoggers,
                ),
              ),
              Layer.provideMerge(ModelManifest.layerTest),
              Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
              Layer.provideMerge(
                mockCommandSpawnerLayer((command, args) => {
                  if (command === "cursor-agent") {
                    cursorSpawned = true;
                  }

                  const joined = args.join(" ");

                  if (joined === "--version") {
                    return {
                      stdout: `${command} 1.0.0\n`,
                      stderr: "",
                      code: 0,
                    };
                  }

                  if (joined === "auth status") {
                    return {
                      stdout: '{"authenticated":true}\n',
                      stderr: "",
                      code: 0,
                    };
                  }

                  throw new Error(`Unexpected args: ${command} ${joined}`);
                }),
              ),
            );

            const runtimeServices = yield* Layer.build(
              Layer.mergeAll(
                Layer.succeed(ServerSettingsModule.ServerSettingsService, serverSettings),
                providerRegistryLayer,
              ),
            ).pipe(Scope.provide(scope));

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              const providers = yield* registry.getProviders;
              assert.deepStrictEqual(providers.map((provider) => provider.instanceId).toSorted(), [
                "claudeAgent",
                "codex",
                "grok",
                "kimi",
                "opencodeGo",
              ]);
              assert.strictEqual(cursorSpawned, false);
            }).pipe(Effect.provide(runtimeServices));
          }),
      );
    });
  },
);
