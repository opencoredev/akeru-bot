import { ProviderInstanceId } from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";
import { type ServerSettings as ContractServerSettings } from "@akeru/contracts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { deepMerge } from "@akeru/shared/Struct";
import { checkCodexProviderStatus } from "./CodexProvider.ts";
import * as ModelCatalog from "../ModelCatalog.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderInstanceRegistryHydrationLive } from "./ProviderInstanceRegistryHydration.ts";
import { ProviderRegistryLive } from "./ProviderRegistry.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettingsModule from "../../serverSettings.ts";
import * as ProviderRegistry from "../Services/ProviderRegistry.ts";
import {
  decodeServerSettings,
  encodedDefaultServerSettings,
  defaultCodexSettings,
  decodeCodexSettings,
  disabledCodexSettings,
  TestHttpClientLive,
  BackgroundPolicyAlwaysRunLayer,
  failingSpawnerLayer,
  hangingScopedSpawnerLayer,
  codexModelCapabilities,
  makeCodexProbeSnapshot,
  makeMutableServerSettingsService,
} from "./test-support/providerProbe.ts";

process.env.T3CODE_CURSOR_ENABLED = "1";

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect("uses the app-server account and model list for provider status", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                skills: [
                  {
                    name: "github:gh-fix-ci",
                    path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
                    enabled: true,
                    displayName: "CI Debug",
                    shortDescription: "Debug failing GitHub Actions checks",
                  },
                ],
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.installed, true);
          assert.strictEqual(status.version, "1.0.0");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "chatgpt");
          assert.strictEqual(status.auth.label, "ChatGPT Pro 20x Subscription");
          assert.strictEqual(status.auth.email, "test@example.com");
          assert.deepStrictEqual(status.models, [
            {
              slug: "gpt-live-codex",
              name: "GPT Live Codex",
              isCustom: false,
              capabilities: codexModelCapabilities,
            },
          ]);
          assert.deepStrictEqual(status.skills, [
            {
              name: "github:gh-fix-ci",
              path: "/Users/test/.codex/skills/gh-fix-ci/SKILL.md",
              enabled: true,
              displayName: "CI Debug",
              shortDescription: "Debug failing GitHub Actions checks",
            },
          ]);
          assert.deepStrictEqual(status.slashCommands, [
            {
              name: "feedback",
              description: "Send this chat and Codex logs to OpenAI",
              input: { hint: "Describe the issue (optional)" },
            },
          ]);
        }),
      );
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect("passes configured launch args to the Codex provider probe", () =>
        Effect.gen(function* () {
          let observedLaunchArgs: string | undefined;
          const settings = decodeCodexSettings({ launchArgs: "--strict-config --enable foo" });

          const status = yield* checkCodexProviderStatus(settings, (input) => {
            observedLaunchArgs = input.launchArgs;

            return Effect.succeed(makeCodexProbeSnapshot());
          });

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(observedLaunchArgs, "--strict-config --enable foo");
        }),
      );
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect("returns unauthenticated when app-server requires OpenAI auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: null,
                  requiresOpenaiAuth: true,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.auth.status, "unauthenticated");
          assert.strictEqual(
            status.message,
            "Codex CLI is not authenticated. Run `codex login` and try again.",
          );
        }),
      );
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect(
        "returns ready with unknown auth when app-server does not require OpenAI auth",
        () =>
          Effect.gen(function* () {
            const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
              Effect.succeed(
                makeCodexProbeSnapshot({
                  account: {
                    account: null,
                    requiresOpenaiAuth: false,
                  },
                }),
              ),
            );

            assert.strictEqual(status.status, "ready");
            assert.strictEqual(status.auth.status, "unknown");
          }),
      );
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect("returns an api key label for codex api key auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "apiKey" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "apiKey");
          assert.strictEqual(status.auth.label, "OpenAI API Key");
        }),
      );
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect("returns an Amazon Bedrock label for codex Bedrock auth", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.succeed(
              makeCodexProbeSnapshot({
                account: {
                  account: { type: "amazonBedrock" },
                  requiresOpenaiAuth: false,
                },
              }),
            ),
          );

          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.auth.status, "authenticated");
          assert.strictEqual(status.auth.type, "amazonBedrock");
          assert.strictEqual(status.auth.label, "Amazon Bedrock");
        }),
      );
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect("returns unavailable when codex is missing", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(defaultCodexSettings, () =>
            Effect.fail(
              new CodexErrors.CodexAppServerSpawnError({
                command: "codex app-server",
                cause: new Error("spawn codex ENOENT"),
              }),
            ),
          );

          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.auth.status, "unknown");
          assert.strictEqual(status.message, "Codex CLI (`codex`) was not found on PATH.");
        }),
      );
    });
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, ServerSettingsModule.layerTest(), TestHttpClientLive))(
  "ProviderRegistry",
  (it) => {
    describe("checkCodexProviderStatus", () => {
      it.effect("closes the app-server probe scope when provider status times out", () =>
        Effect.gen(function* () {
          const killCalls = yield* Ref.make(0);

          const statusFiber = yield* checkCodexProviderStatus(defaultCodexSettings).pipe(
            Effect.provide(hangingScopedSpawnerLayer(killCalls)),
            Effect.forkChild,
          );

          yield* Effect.yieldNow;
          yield* TestClock.adjust("11 seconds");
          yield* Effect.yieldNow;

          const status = yield* Fiber.join(statusFiber);
          assert.strictEqual(status.status, "error");
          assert.strictEqual(
            status.message,
            "Timed out while checking Codex app-server provider status.",
          );
          assert.strictEqual(yield* Ref.get(killCalls), 1);
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
        "publishes harness credential readiness even when the Codex binary is missing",
        () =>
          Effect.gen(function* () {
            const missingBinary = `t3code_codex_missing_`;

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
                    codex_personal: {
                      driver: "codex",
                      displayName: "Codex Personal",
                      enabled: true,
                      config: {
                        binaryPath: missingBinary,
                        homePath: `/tmp/${missingBinary}_home`,
                      },
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
              Layer.provideMerge(ModelCatalog.layerTest),
              Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
              Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
            );

            const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
              Scope.provide(scope),
            );

            yield* Effect.gen(function* () {
              const registry = yield* ProviderRegistry.ProviderRegistry;
              yield* registry.refreshInstance(ProviderInstanceId.make("codex_personal"));
              const providers = yield* registry.getProviders;

              const codexPersonal = providers.find(
                (provider) => provider.instanceId === "codex_personal",
              );

              assert.notStrictEqual(
                codexPersonal,
                undefined,
                `Expected the aggregator to know about codex_personal; instead saw: ${providers
                  .map((provider) => provider.instanceId)
                  .join(", ")}`,
              );
              assert.strictEqual(codexPersonal?.status, "warning");
              assert.strictEqual(codexPersonal?.installed, true);
              assert.strictEqual(
                codexPersonal?.message,
                "This Codex instance needs OPENAI_API_KEY for the Akeru harness.",
              );
              assert.ok((codexPersonal?.models.length ?? 0) > 0);
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
      it.effect("refreshes harness readiness when settings change Codex credentials", () =>
        Effect.gen(function* () {
          const firstMissing = `t3code_codex_first_`;
          const secondMissing = `t3code_codex_second_`;
          const spawnedCommands: Array<string> = [];

          const serverSettings = yield* makeMutableServerSettingsService(
            decodeServerSettings(
              deepMerge(encodedDefaultServerSettings, {
                providers: {
                  codex: { enabled: true, binaryPath: firstMissing },
                  claudeAgent: { enabled: false },
                  grok: { enabled: false },
                  opencode: { enabled: false },
                },
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
            Layer.provideMerge(ModelCatalog.layerTest),
            Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
            Layer.updateService(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
              ChildProcessSpawner.make((command) => {
                spawnedCommands.push((command as { readonly command: string }).command);

                return spawner.spawn(command);
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
          );

          const runtimeServices = yield* Layer.build(providerRegistryLayer).pipe(
            Scope.provide(scope),
          );

          yield* Effect.gen(function* () {
            const registry = yield* ProviderRegistry.ProviderRegistry;
            yield* registry.refreshInstance(ProviderInstanceId.make("codex"));
            const initialProviders = yield* registry.getProviders;

            const initialCodex = initialProviders.find(
              (provider) => provider.instanceId === "codex",
            );

            assert.strictEqual(initialCodex?.status, "warning");
            assert.strictEqual(initialCodex?.installed, true);
            assert.deepStrictEqual(spawnedCommands, []);

            const nextProbe = yield* Stream.runHead(
              registry.streamChanges.pipe(
                Stream.filter(
                  (providers) =>
                    providers.find((provider) => provider.instanceId === "codex")?.status ===
                    "ready",
                ),
              ),
            ).pipe(Effect.forkChild({ startImmediately: true }));

            yield* Effect.yieldNow;
            yield* serverSettings.updateSettings({
              providerInstances: {
                codex: {
                  driver: "codex",
                  displayName: "Codex",
                  enabled: true,
                  config: { binaryPath: secondMissing },
                  environment: [{ name: "OPENAI_API_KEY", value: "test-key" }],
                },
              } as ContractServerSettings["providerInstances"],
            });

            const refreshed = Option.getOrThrow(yield* Fiber.join(nextProbe));

            const reprobedCodex = refreshed.find((provider) => provider.instanceId === "codex");
            assert.deepStrictEqual(spawnedCommands, []);
            assert.strictEqual(reprobedCodex?.status, "ready");
            assert.strictEqual(reprobedCodex?.installed, true);
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
      it.effect("skips codex probes entirely when the provider is disabled", () =>
        Effect.gen(function* () {
          const status = yield* checkCodexProviderStatus(disabledCodexSettings).pipe(
            Effect.provide(failingSpawnerLayer("spawn codex ENOENT")),
          );

          assert.strictEqual(status.enabled, false);
          assert.strictEqual(status.status, "disabled");
          assert.strictEqual(status.installed, false);
          assert.strictEqual(status.message, "Codex is disabled in Akeru Bot settings.");
        }),
      );
    });
  },
);
