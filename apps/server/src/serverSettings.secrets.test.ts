import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

import {
  makeFailingSecretStoreLayer,
  makeServerSettingsLayer,
} from "./serverSettingsTestSupport.ts";

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("preserves context when reading a provider environment secret fails", () => {
    const platformCause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFile",
      pathOrDescriptor: "provider environment secret",
      description: "Secret backend unavailable.",
    });

    const cause = new ServerSecretStore.SecretStoreReadError({
      resource: "provider environment secret",
      cause: platformCause,
    });

    const configLayer = Layer.fresh(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-server-settings-secret-failure-test-",
      }),
    );

    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(makeFailingSecretStoreLayer(cause)),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
      Layer.provideMerge(configLayer),
    );

    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"OPENROUTER_API_KEY","value":"","sensitive":true,"valueRedacted":true}],"config":{}}}}',
      );

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-secret",
        providerInstanceId: "codex_personal",
        environmentVariable: "OPENROUTER_API_KEY",
      });
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(settingsLayer));
  });

  it.effect("keeps the inline value on disk when secret migration fails", () => {
    const cause = new ServerSecretStore.SecretStorePersistError({
      resource: "provider environment secret",
      cause: new Error("Secret storage unavailable"),
    });

    const secretLayer = Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.map(ServerSecretStore.ServerSecretStore, (store) => ({
        ...store,
        set: () => Effect.fail(cause),
      })),
    ).pipe(Layer.provide(ServerSecretStore.layer));

    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(secretLayer),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
      Layer.provideMerge(
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3code-inline-secret-failure-test-",
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const service = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;

      const original =
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}';

      yield* fs.writeFileString(config.settingsPath, original);

      const error = yield* Effect.flip(
        service.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              environment: [{ name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true }],
              config: {},
            },
          },
        }),
      );

      assert.equal(error.operation, "write-secret");
      assert.strictEqual(error.cause, cause);
      assert.equal(yield* fs.readFileString(config.settingsPath), original);
      const settings = yield* service.getSettings;
      assert.equal(
        settings.providerInstances[instanceId]?.environment?.[0]?.value,
        "inline-test-token",
      );
    }).pipe(Effect.provide(settingsLayer));
  });

  for (const { label, variable, expected, duplicate } of [
    {
      label: "preserves an inline secret on a redacted settings save",
      variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
      expected: "inline-test-token",
    },
    {
      label: "preserves the effective last inline secret when names are duplicated",
      variable: { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
      expected: "last-inline-test-token",
      duplicate: true,
    },
    {
      label: "replaces an inline secret with an explicit value",
      variable: { name: "API_TOKEN", value: "replacement-test-token", sensitive: true },
      expected: "replacement-test-token",
    },
    {
      label: "clears an inline secret with an explicit empty value",
      variable: { name: "API_TOKEN", value: "", sensitive: true },
      expected: "",
    },
  ]) {
    it.effect(label, () =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("codex_personal");
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(
          serverConfig.settingsPath,
          duplicate
            ? '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true},{"name":"API_TOKEN","value":"last-inline-test-token","sensitive":true}],"config":{}}}}'
            : '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"API_TOKEN","value":"inline-test-token","sensitive":true}],"config":{}}}}',
        );
        const initial = yield* serverSettings.getSettings;
        assert.equal(
          initial.providerInstances[instanceId]?.environment?.[0]?.value,
          "inline-test-token",
        );

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              displayName: "Renamed provider",
              environment: duplicate ? [variable, variable] : [variable],
              config: {},
            },
          },
        });

        assert.equal(next.providerInstances[instanceId]?.environment?.[0]?.value, expected);
        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.notInclude(raw, "inline-test-token");
        assert.notInclude(raw, "replacement-test-token");

        const reloaded = yield* Effect.gen(function* () {
          const fresh = yield* ServerSettingsModule.ServerSettingsService;

          return yield* fresh.getSettings;
        }).pipe(
          Effect.provide(
            Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
          ),
        );

        assert.equal(reloaded.providerInstances[instanceId]?.environment?.[0]?.value, expected);
      }).pipe(Effect.provide(makeServerSettingsLayer())),
    );
  }

  it.effect("stores sensitive provider instance environment values outside settings.json", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-or-secret", sensitive: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "sk-or-secret",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-or-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_personal.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Personal",
            environment: [
              { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.equal(
        roundTripped.providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-or-secret",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("reuses materialized secrets until settings or secrets change", () => {
    const secretReads = { count: 0 };

    const countingSecretStoreLayer = Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.gen(function* () {
        const store = yield* ServerSecretStore.ServerSecretStore;

        return ServerSecretStore.ServerSecretStore.of({
          ...store,
          get: (name) => {
            secretReads.count += 1;

            return store.get(name);
          },
        });
      }),
    ).pipe(Layer.provide(ServerSecretStore.layer));

    const configLayer = Layer.fresh(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-server-settings-materialize-cache-test-",
      }),
    );

    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(countingSecretStoreLayer),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
      Layer.provideMerge(configLayer),
    );

    const instanceId = ProviderInstanceId.make("codex_personal");

    const withSecret = (value: string) => ({
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          environment: [{ name: "OPENROUTER_API_KEY", value, sensitive: true }],
          config: {},
        },
      },
    });

    return Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* serverSettings.updateSettings(withSecret("sk-first"));

      const readsBeforeFirst = secretReads.count;
      const first = yield* serverSettings.getSettings;
      assert.equal(first.providerInstances[instanceId]?.environment?.[0]?.value, "sk-first");
      const readsAfterFirst = secretReads.count;
      const readsPerMaterialize = readsAfterFirst - readsBeforeFirst;
      const second = yield* serverSettings.getSettings;
      assert.equal(second.providerInstances[instanceId]?.environment?.[0]?.value, "sk-first");
      assert.equal(secretReads.count, readsAfterFirst);

      yield* serverSettings.updateSettings(withSecret("sk-second"));
      const updated = yield* serverSettings.getSettings;
      assert.equal(updated.providerInstances[instanceId]?.environment?.[0]?.value, "sk-second");
      assert.isAbove(secretReads.count, readsAfterFirst);

      // Concurrent misses after a change share one materialization.
      yield* serverSettings.updateSettings(withSecret("sk-third"));
      const readsBeforeBurst = secretReads.count;

      const burst = yield* Effect.all(
        Array.from({ length: 5 }, () => serverSettings.getSettings),
        {
          concurrency: "unbounded",
        },
      );

      for (const settings of burst) {
        assert.equal(settings.providerInstances[instanceId]?.environment?.[0]?.value, "sk-third");
      }

      assert.equal(secretReads.count - readsBeforeBurst, readsPerMaterialize);
    }).pipe(Effect.provide(settingsLayer));
  });

  it.effect("rejects plaintext sandbox secrets loaded from settings.json", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"sandbox":{"providers":{"e2b":{"environment":[{"name":"E2B_API_KEY","value":"plaintext-key","sensitive":true}]}}}}',
      );

      const error = yield* Effect.flip(serverSettings.getSettings);
      assert.deepInclude(error, {
        operation: "validate-sandbox",
        providerInstanceId: "sandbox:e2b",
        environmentVariable: "E2B_API_KEY",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("rejects plaintext sandbox secrets after a valid redacted marker", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"sandbox":{"providers":{"e2b":{"environment":[{"name":"E2B_API_KEY","value":"","sensitive":true,"valueRedacted":true},{"name":"E2B_API_KEY","value":"plaintext-key","sensitive":true}]}}}}',
      );

      const error = yield* Effect.flip(serverSettings.getSettings);
      assert.deepInclude(error, {
        operation: "validate-sandbox",
        providerInstanceId: "sandbox:e2b",
        environmentVariable: "E2B_API_KEY",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("rejects a sandbox secret marker without a stored secret", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const error = yield* Effect.flip(
        serverSettings.updateSettings({
          sandbox: {
            providers: {
              e2b: {
                environment: [
                  { name: "E2B_API_KEY", value: "", sensitive: true, valueRedacted: true },
                ],
              },
            },
          },
        }),
      );

      assert.deepInclude(error, {
        operation: "validate-sandbox",
        providerInstanceId: "sandbox:e2b",
        environmentVariable: "E2B_API_KEY",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("stores sandbox secrets outside settings.json and redacts client settings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      const next = yield* serverSettings.updateSettings({
        sandbox: {
          defaultProvider: "e2b",
          providers: {
            e2b: {
              environment: [{ name: "E2B_API_KEY", value: "e2b-secret", sensitive: true }],
            },
            railway: {
              environment: [
                { name: "RAILWAY_API_TOKEN", value: "railway-secret", sensitive: true },
                { name: "RAILWAY_ENVIRONMENT_ID", value: "environment-id", sensitive: false },
              ],
            },
            tenki: {
              environment: [{ name: "TENKI_API_KEY", value: "tenki-secret", sensitive: true }],
            },
          },
        },
      });

      assert.equal(next.sandbox.providers.e2b.environment[0]?.value, "e2b-secret");
      assert.equal(next.sandbox.providers.railway.environment[0]?.value, "railway-secret");
      assert.equal(next.sandbox.providers.railway.environment[1]?.value, "environment-id");
      assert.equal(next.sandbox.providers.tenki.environment[0]?.value, "tenki-secret");
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "e2b-secret");
      assert.notInclude(raw, "railway-secret");
      assert.notInclude(raw, "tenki-secret");

      const clientSettings = ServerSettingsModule.redactServerSettingsForClient(next);
      assert.deepInclude(clientSettings.sandbox.providers.e2b.environment[0], {
        value: "",
        valueRedacted: true,
      });
      assert.deepInclude(clientSettings.sandbox.providers.railway.environment[0], {
        value: "",
        valueRedacted: true,
      });
      assert.deepInclude(clientSettings.sandbox.providers.railway.environment[1], {
        value: "environment-id",
        sensitive: false,
      });
      assert.deepInclude(clientSettings.sandbox.providers.tenki.environment[0], {
        value: "",
        valueRedacted: true,
      });

      const roundTripped = yield* serverSettings.updateSettings({
        sandbox: clientSettings.sandbox,
      });

      assert.equal(roundTripped.sandbox.providers.e2b.environment[0]?.value, "e2b-secret");
      assert.equal(roundTripped.sandbox.providers.railway.environment[0]?.value, "railway-secret");
      assert.equal(roundTripped.sandbox.providers.railway.environment[1]?.value, "environment-id");
      assert.equal(roundTripped.sandbox.providers.tenki.environment[0]?.value, "tenki-secret");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("stores and redacts the Browserbase API key outside settings.json", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      const next = yield* serverSettings.updateSettings({
        browserProvider: {
          enabled: true,
          browserbaseApiKey: "browserbase-secret",
          browserbaseApiKeyRedacted: false,
        },
      });

      assert.deepInclude(next.browserProvider, {
        enabled: true,
        browserbaseApiKey: "browserbase-secret",
        browserbaseApiKeyRedacted: true,
      });
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "browserbase-secret");

      const redacted = ServerSettingsModule.redactServerSettingsForClient(next);
      assert.deepInclude(redacted.browserProvider, {
        enabled: true,
        browserbaseApiKey: "",
        browserbaseApiKeyRedacted: true,
      });

      const preserved = yield* serverSettings.updateSettings({
        browserProvider: { enabled: false },
      });

      assert.equal(preserved.browserProvider.browserbaseApiKey, "browserbase-secret");
      assert.isFalse(preserved.browserProvider.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
