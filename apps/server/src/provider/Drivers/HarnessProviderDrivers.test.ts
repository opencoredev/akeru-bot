// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodePath from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";
import { fakeJwt } from "../../subscription-auth/testUtils/scriptedHttpClient.ts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { layerTest as settingsLayer, ServerSettingsService } from "../../serverSettings.ts";
import { SubscriptionAuthService } from "../../subscription-auth/service.ts";
import { makeSubscriptionProviderMutation } from "../../subscription-auth/providerMutation.ts";
import { makeProviderInstanceRegistry } from "../Layers/ProviderInstanceRegistryLive.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderRegistryLive } from "../Layers/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import type { ProviderDriver, ProviderDriverCreateInput } from "../ProviderDriver.ts";
import { CodexDriver } from "./CodexDriver.ts";
import { ClaudeDriver } from "./ClaudeDriver.ts";
import { GrokDriver } from "./GrokDriver.ts";

const epoch = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const testLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "akeru-harness-driver-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
  settingsLayer(),
  ModelManifest.layerTest,
  Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("No HTTP probes expected")),
  ),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    reportHostPowerState: () => Effect.void,
    snapshot: Effect.succeed({
      hostPower: {
        source: "unknown",
        idle: "unknown",
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        stale: true,
        idleSeconds: null,
        thermalState: "unknown",
        updatedAt: epoch,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: true,
      updatedAt: epoch,
    }),
    streamChanges: Stream.empty,
    hasDemand: () => Effect.succeed(true),
    shouldRunScopeWork: () => Effect.succeed(true),
    shouldRunOpportunisticWork: Effect.succeed(true),
  }),
);

function driverCase<Config, Environment>(driver: ProviderDriver<Config, Environment>) {
  return {
    rawDriver: driver,
    driverKind: driver.driverKind,
    create: (input: Omit<ProviderDriverCreateInput<Config>, "config"> & { homePath?: string }) =>
      driver.create({
        ...input,
        config: {
          ...driver.defaultConfig(),
          binaryPath: "/no/provider/cli",
          customModels: ["custom-model", "gpt-6-sol"],
          ...(input.homePath ? { homePath: input.homePath } : {}),
        },
      }),
  };
}

const cases = [
  {
    driver: driverCase(CodexDriver),
    provider: "openai-codex",
    name: "ChatGPT",
    key: "OPENAI_API_KEY",
  },
  {
    driver: driverCase(ClaudeDriver),
    provider: "anthropic",
    name: "Claude",
    key: "ANTHROPIC_API_KEY",
  },
  { driver: driverCase(GrokDriver), provider: "xai", name: "Grok", key: "XAI_API_KEY" },
] as const;

// Ambient provider keys would count as explicit credentials and mask saved-credential readiness.
for (const name of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "XAI_API_KEY",
]) {
  vi.stubEnv(name, "");
}

const undefinedValuePaths = (value: unknown, path = "$"): string[] =>
  value === undefined
    ? [path]
    : value !== null && typeof value === "object"
      ? Object.entries(value).flatMap(([key, child]) =>
          undefinedValuePaths(child, `${path}.${key}`),
        )
      : [];

it.layer(testLayer)("Harness provider drivers without CLIs", (it) => {
  for (const { driver, provider, name, key } of cases) {
    describe(name, () => {
      it.effect(
        "publishes login and logout immediately for default and named instances with health refresh disabled",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const config = yield* ServerConfig;
              const settings = yield* ServerSettingsService;
              const auth = yield* SubscriptionAuthService.forSecretsDir(config.secretsDir);
              const namedId = ProviderInstanceId.make(`${driver.driverKind}_mutation`);
              const defaultId = ProviderInstanceId.make(String(driver.driverKind));
              yield* Effect.promise(() => auth.logout(provider));
              yield* Effect.promise(() => auth.logout(provider, namedId));
              const initial = yield* settings.updateSettings({
                providerHealthRefreshInterval: Duration.millis(0),
                providers: {
                  codex: { enabled: false, binaryPath: "/no/provider/cli" },
                  claudeAgent: { enabled: false, binaryPath: "/no/provider/cli" },
                  grok: { enabled: false, binaryPath: "/no/provider/cli" },
                },
                providerInstances: {
                  [namedId]: {
                    driver: driver.driverKind,
                    displayName: "Named mutation account",
                    enabled: true,
                    environment: [{ name: "PATH", value: "", sensitive: false }],
                    config: { binaryPath: "/no/provider/cli" },
                  },
                },
              });
              const built = yield* makeProviderInstanceRegistry({
                drivers: [driver.rawDriver],
                configMap: deriveProviderInstanceConfigMap(initial),
              });
              const context = yield* Layer.build(
                ProviderRegistryLive.pipe(
                  Layer.provide(Layer.succeed(ProviderInstanceRegistry, built.registry)),
                ),
              );
              const registry = Context.get(context, ProviderRegistry);
              const mutate = makeSubscriptionProviderMutation(
                auth,
                settings,
                built.mutator,
                registry,
              );
              for (const instanceId of [namedId, defaultId]) {
                const receive = (status: "authenticated" | "unauthenticated") =>
                  registry.streamChanges.pipe(
                    Stream.filter((providers) =>
                      providers.some(
                        (snapshot) =>
                          snapshot.instanceId === instanceId && snapshot.auth.status === status,
                      ),
                    ),
                    Stream.runHead,
                    Effect.forkChild({ startImmediately: true }),
                  );
                const connected = yield* receive("authenticated");
                const deviceLogin = provider === "openai-codex" && instanceId === defaultId;
                if (deviceLogin) {
                  let polls = 0;
                  yield* Effect.acquireRelease(
                    Effect.sync(() =>
                      vi.stubGlobal(
                        "fetch",
                        vi.fn(async (input: string | URL | Request) => {
                          const url = input instanceof Request ? input.url : String(input);
                          if (url.endsWith("/deviceauth/usercode"))
                            return Response.json({
                              device_auth_id: "mutation-device",
                              user_code: "TEST-CODE",
                              interval: "5",
                            });
                          if (url.endsWith("/deviceauth/token"))
                            return ++polls === 1
                              ? new Response("", { status: 403 })
                              : Response.json({
                                  authorization_code: "test-code",
                                  code_verifier: "test-verifier",
                                });
                          if (url.endsWith("/oauth/token"))
                            return Response.json({
                              access_token: "oauth-mutation-key",
                              refresh_token: "oauth-refresh",
                              expires_in: 3600,
                              id_token: fakeJwt({
                                "https://api.openai.com/auth": {
                                  chatgpt_account_id: "test-account",
                                },
                              }),
                            });
                          throw new Error(`Unexpected OAuth request: ${url}`);
                        }),
                      ),
                    ),
                    () => Effect.sync(() => vi.unstubAllGlobals()),
                  );
                }
                const login = yield* Effect.promise(() =>
                  auth.startLogin(provider, {
                    authMode: deviceLogin ? "oauth" : "api-key",
                    ...(instanceId === namedId ? { instanceId } : {}),
                  }),
                );
                if (deviceLogin) {
                  expect(
                    yield* mutate(Effect.promise(() => auth.pollLogin(login.loginId))),
                  ).toMatchObject({ status: "pending" });
                  expect(
                    (yield* registry.getProviders).find(
                      (snapshot) => snapshot.instanceId === instanceId,
                    )?.auth.status,
                  ).toBe("unauthenticated");
                }
                const result = yield* mutate(
                  Effect.promise(() =>
                    deviceLogin
                      ? auth.pollLogin(login.loginId)
                      : auth.completeLogin(login.loginId, "mutation-test-key"),
                  ),
                );
                expect(result.status).toBe("connected");
                expect(
                  (yield* registry.getProviders).find(
                    (snapshot) => snapshot.instanceId === instanceId,
                  ),
                ).toMatchObject({
                  enabled: true,
                  status: "ready",
                  auth: { status: "authenticated" },
                });
                expect((yield* Fiber.join(connected))._tag).toBe("Some");
                const disconnected = yield* receive("unauthenticated");
                yield* mutate(
                  Effect.promise(() =>
                    auth.logout(provider, instanceId === namedId ? instanceId : undefined),
                  ),
                );
                expect(
                  (yield* registry.getProviders).find(
                    (snapshot) => snapshot.instanceId === instanceId,
                  )?.auth.status,
                ).toBe("unauthenticated");
                expect((yield* Fiber.join(disconnected))._tag).toBe("Some");
              }
            }),
          ),
      );

      it.effect("uses saved credentials for initial readiness and refresh, without a CLI", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const config = yield* ServerConfig;
            const fs = yield* FileSystem.FileSystem;
            yield* fs.makeDirectory(config.secretsDir, { recursive: true });
            const create = () =>
              driver.create({
                instanceId: ProviderInstanceId.make(String(driver.driverKind)),
                displayName: undefined,
                environment: [{ name: "PATH", value: "", sensitive: false }],
                enabled: true,
              });
            const instance = yield* create();
            const before = yield* instance.snapshot.getSnapshot;
            expect(before).toMatchObject({
              installed: true,
              availability: "available",
              status: "warning",
              auth: { status: "unauthenticated" },
              message: `Connect ${name} in Settings.`,
            });
            expect(before.models.length).toBeGreaterThan(1);
            yield* fs.writeFileString(
              NodePath.join(config.secretsDir, "subscription-auth.json"),
              JSON.stringify({
                [provider]: {
                  type: "oauth",
                  access: "test-access",
                  refresh: "test-refresh",
                  expires: 4_102_444_800_000,
                },
              }),
            );
            const after = yield* instance.snapshot.refresh;
            expect(after).toMatchObject({
              installed: true,
              availability: "available",
              status: "ready",
              auth: { status: "authenticated" },
            });
            expect(after.message).toBeUndefined();
            // The RPC transport rejects present-but-undefined keys as non-JSON.
            expect(undefinedValuePaths(before)).toEqual([]);
            expect(undefinedValuePaths(after)).toEqual([]);
            expect(after.models).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ slug: "custom-model", isCustom: true }),
              ]),
            );
            expect(after.models.some((model) => !model.isCustom && !model.isLegacy)).toBe(true);
            expect(new Set(after.models.map((model) => model.slug)).size).toBe(after.models.length);
            if (driver.driverKind === "codex") {
              expect(after.models).toContainEqual(
                expect.objectContaining({ slug: "gpt-5.4", isCustom: false, isLegacy: true }),
              );
              expect(
                after.models.find((model) => model.slug === "gpt-6-sol")?.capabilities
                  ?.optionDescriptors,
              ).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ id: "reasoningEffort", currentValue: "medium" }),
                  expect.objectContaining({ id: "serviceTier", currentValue: "default" }),
                ]),
              );
            }
            if (driver.driverKind === "grok") {
              expect(after.models).toContainEqual(
                expect.objectContaining({ slug: "grok-build", name: "Grok 4.6", isDefault: true }),
              );
            }
            const connectedInstance = yield* create();
            expect((yield* connectedInstance.snapshot.getSnapshot).status).toBe("ready");
            expect(connectedInstance.adapter).toBeUndefined();
            expect(connectedInstance.textGeneration).toBeDefined();
            if (instance.snapshotForCwd)
              expect((yield* instance.snapshotForCwd(config.cwd)).skills).toEqual([]);
          }),
        ),
      );

      it.effect("keeps a named instance's saved account separate from the default account", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const config = yield* ServerConfig;
            const fs = yield* FileSystem.FileSystem;
            yield* fs.makeDirectory(config.secretsDir, { recursive: true });
            const instanceId = ProviderInstanceId.make(`${driver.driverKind}_named`);
            yield* fs.writeFileString(
              NodePath.join(config.secretsDir, "subscription-auth.json"),
              JSON.stringify({ [provider]: { type: "api-key", access: "default-test-key" } }),
            );
            const instance = yield* driver.create({
              instanceId,
              displayName: "Named account",
              environment: [{ name: "PATH", value: "", sensitive: false }],
              enabled: true,
            });
            expect(instance.mastraConnection?.useSavedCredential).toBe(true);
            expect((yield* instance.snapshot.getSnapshot).auth.status).toBe("unauthenticated");
            yield* fs.writeFileString(
              NodePath.join(config.secretsDir, "subscription-auth.json"),
              JSON.stringify({
                [`instance:${provider}:${instanceId}`]: {
                  type: "api-key",
                  access: "named-test-key",
                },
              }),
            );
            expect((yield* instance.snapshot.refresh).status).toBe("ready");
          }),
        ),
      );

      it.effect(
        "uses explicit credentials without falling back to a saved account or CLI home",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const config = yield* ServerConfig;
              const fs = yield* FileSystem.FileSystem;
              yield* fs.makeDirectory(config.secretsDir, { recursive: true });
              yield* fs.writeFileString(
                NodePath.join(config.secretsDir, "subscription-auth.json"),
                JSON.stringify({ [provider]: { type: "api-key", access: "saved-key" } }),
              );
              for (const value of ["", "explicit-key"]) {
                const instance = yield* driver.create({
                  instanceId: ProviderInstanceId.make(`${driver.driverKind}_custom`),
                  displayName: undefined,
                  environment: [
                    { name: "PATH", value: "", sensitive: false },
                    { name: key, value, sensitive: true },
                  ],
                  enabled: true,
                  homePath: "/no/provider/home",
                });
                const snapshot = yield* instance.snapshot.getSnapshot;
                expect(instance.mastraConnection?.useSavedCredential).toBe(false);
                expect(snapshot.installed).toBe(true);
                expect(snapshot.status).toBe(value ? "ready" : "warning");
                expect(snapshot.auth.status).toBe(value ? "authenticated" : "unauthenticated");
                if (!value) expect(snapshot.message).toContain("Akeru harness");
              }
            }),
          ),
      );
    });
  }
});
