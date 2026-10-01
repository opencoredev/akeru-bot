import { ServerSettings, ServerSettingsPatch } from "@akeru/contracts";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as Schema from "effect/Schema";

import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

import * as ServerConfig from "./config.ts";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

import * as ServerSettingsModule from "./serverSettings.ts";

export const decodeSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);

export const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

export const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

export const makeFailingSecretStoreLayer = (cause: ServerSecretStore.SecretStoreError) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.fail(cause),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    }),
  );

export const recordProviderUsage = (provider: string, instanceId: string | null = provider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_instance_id,
        updated_at
      )
      VALUES (
        ${`thread-${instanceId ?? provider}`},
        ${"ready"},
        ${provider},
        ${instanceId},
        ${"2026-08-25T00:00:00.000Z"}
      )
    `;
  });
